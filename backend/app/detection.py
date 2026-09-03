"""민감정보 탐지와 등급 판정.

이 모듈은 프런트엔드 목 구현(frontend/src/api/mock.ts findCandidates)의 규칙을
그대로 옮긴 것이다. 규칙이 어긋나면 시연 시나리오 G-01~G-04의 등급이 달라지고
감사 로그의 라벨 집계가 프런트와 맞지 않는다. 규칙을 고칠 때는 양쪽을 함께 고친다.

오프셋 규약: 프런트엔드는 문자열을 UTF-16 코드 단위로 자른다. 파이썬 문자열
인덱스는 코드 포인트 단위이므로, 밖으로 내보내는 start/end 는 UTF-16 기준으로
환산한다. 한글은 두 기준이 같지만 이모지 같은 BMP 밖 문자가 섞이면 어긋난다.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Iterable, Literal, Sequence

Grade = Literal["normal", "caution", "confidential", "blocked"]
Route = Literal["external_llm", "internal_llm", "masked_external", "blocked"]
DetectionType = Literal[
    "rrn", "phone", "email", "account",
    "partner", "price", "source_code", "api_key",
    "unreadable_attachment",
]

GRADE_WEIGHT: dict[str, int] = {
    "normal": 0,
    "caution": 1,
    "confidential": 2,
    "blocked": 3,
}

ROUTE_BY_GRADE: dict[str, str] = {
    "normal": "external_llm",
    "caution": "masked_external",
    "confidential": "internal_llm",
    "blocked": "blocked",
}

DICTIONARY_PRIORITY = 3
DICTIONARY_ACTIVE_LIMIT = 300
DICTIONARY_PASTE_ROW_LIMIT = 200

# 사전 항목 유형별 표시·탐지 설정. dictionary.ts 의 dictionaryPresets 와 같아야 한다.
DICTIONARY_PRESETS: dict[str, dict] = {
    "partner": {
        "typeLabel": "거래처", "detectionType": "partner", "label": "거래처",
        "tokenLabel": "거래처", "defaultGrade": "confidential", "confidence": 0.96,
    },
    "product_code": {
        "typeLabel": "제품코드", "detectionType": "partner", "label": "제품코드",
        "tokenLabel": "제품", "defaultGrade": "confidential", "confidence": 0.96,
    },
    "price_expression": {
        "typeLabel": "단가표현", "detectionType": "price", "label": "단가",
        "tokenLabel": "단가", "defaultGrade": "confidential", "confidence": 0.95,
    },
    "other": {
        "typeLabel": "기타", "detectionType": "partner", "label": "사내 용어",
        "tokenLabel": "용어", "defaultGrade": "caution", "confidence": 0.96,
    },
}


@dataclass(frozen=True)
class Candidate:
    type: str
    label: str
    token_label: str
    confidence: float
    severity: str
    priority: int
    start: int
    end: int


@dataclass(frozen=True)
class DictionaryTerm:
    """탐지에 실제로 쓰이는 사전 항목의 최소 형태."""
    term: str
    entry_type: str
    grade: str
    active: bool


# 판정 불가 첨부. 추정이 아니라 사실이므로 confidence 는 1이다.
# 별도 분기를 두지 않고 탐지 후보로 만들어 등급 계산이 자동으로 blocked 를 뽑게 한다.
# 판정 불가가 '일반'으로 통과하는 경로를 구조적으로 없앤다.
UNREADABLE_ATTACHMENT_RE = re.compile(r"^--- 첨부\d+ · 내용을 읽지 못함 ---$", re.M)

_REGEX_RULES: list[tuple[re.Pattern[str], dict]] = [
    (UNREADABLE_ATTACHMENT_RE, {
        "type": "unreadable_attachment", "label": "판정 불가", "token_label": "판독불가",
        "confidence": 1.0, "severity": "blocked", "priority": 0,
    }),
    (re.compile(r"\d{6}-\d{7}"), {
        "type": "rrn", "label": "주민등록번호", "token_label": "주민번호",
        "confidence": 0.99, "severity": "blocked", "priority": 0,
    }),
    (re.compile(r"(sk|api|token)[-_][A-Za-z0-9]{8,}", re.I), {
        "type": "api_key", "label": "API 키", "token_label": "키",
        "confidence": 0.98, "severity": "blocked", "priority": 1,
    }),
    (re.compile(r"function |class |SELECT |import |=>"), {
        "type": "source_code", "label": "소스 코드", "token_label": "코드",
        "confidence": 0.9, "severity": "confidential", "priority": 2,
    }),
]

# 사전 매칭은 priority 3 으로 위 규칙과 아래 규칙 사이에 들어간다.
_REGEX_RULES_AFTER_DICTIONARY: list[tuple[re.Pattern[str], dict]] = [
    (re.compile(r"단가\s*[\d,]+\s*원"), {
        "type": "price", "label": "단가", "token_label": "단가",
        "confidence": 0.95, "severity": "confidential", "priority": 4,
    }),
    # 전화번호도 계좌번호 형태와 일치할 수 있어 더 구체적인 전화 규칙을 먼저 적용한다.
    (re.compile(r"01[016-9]-?\d{3,4}-?\d{4}"), {
        "type": "phone", "label": "전화번호", "token_label": "전화",
        "confidence": 0.98, "severity": "caution", "priority": 5,
    }),
    (re.compile(r"\d{3}-\d{2,6}-\d{2,6}"), {
        "type": "account", "label": "계좌번호", "token_label": "계좌",
        "confidence": 0.92, "severity": "caution", "priority": 6,
    }),
    (re.compile(r"[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}", re.I), {
        "type": "email", "label": "이메일", "token_label": "이메일",
        "confidence": 0.98, "severity": "caution", "priority": 7,
    }),
]

# 공통 계약에 name 유형이 없으므로 사전 기반 고유명사인 partner 유형으로 전달한다.
# 화면과 집계는 label/tokenLabel 을 쓰므로 이름 표기와 주의 등급은 그대로 유지된다.
_NAME_LITERALS = ("홍길동", "김철수", "이영희")
_NAME_CANDIDATE = {
    "type": "partner", "label": "이름", "token_label": "이름",
    "confidence": 0.96, "severity": "caution", "priority": 8,
}


def _add_regex(text: str, out: list[Candidate], pattern: re.Pattern[str], spec: dict) -> None:
    for match in pattern.finditer(text):
        if not match.group(0):
            continue
        out.append(Candidate(start=match.start(), end=match.end(), **spec))


def _add_literals(text: str, out: list[Candidate], literals: Iterable[str], spec: dict) -> None:
    for literal in literals:
        if not literal:
            # 빈 문자열이면 탐색 위치가 전진하지 않아 무한 루프에 빠진다.
            continue
        from_index = 0
        while from_index < len(text):
            start = text.find(literal, from_index)
            if start == -1:
                break
            out.append(Candidate(start=start, end=start + len(literal), **spec))
            from_index = start + len(literal)


def _overlaps(first: Candidate, second: Candidate) -> bool:
    return first.start < second.end and second.start < first.end


def find_candidates(text: str, entries: Sequence[DictionaryTerm] = ()) -> list[Candidate]:
    candidates: list[Candidate] = []

    for pattern, spec in _REGEX_RULES:
        _add_regex(text, candidates, pattern, spec)

    for entry in entries:
        if not entry.active:
            continue
        preset = DICTIONARY_PRESETS.get(entry.entry_type)
        if preset is None:
            continue
        _add_literals(text, candidates, [entry.term], {
            "type": preset["detectionType"],
            "label": preset["label"],
            "token_label": preset["tokenLabel"],
            "confidence": preset["confidence"],
            "severity": entry.grade,
            "priority": DICTIONARY_PRIORITY,
        })

    for pattern, spec in _REGEX_RULES_AFTER_DICTIONARY:
        _add_regex(text, candidates, pattern, spec)

    _add_literals(text, candidates, _NAME_LITERALS, _NAME_CANDIDATE)

    # 겹치는 구간은 하나만 살아남으므로 심각도가 높은 후보를 먼저 채택해야 한다.
    # start 순으로 채택하면 앞서 시작한 낮은 등급이 뒤에 오는 높은 등급을 덮어,
    # 등급이 내려가고 원문 일부가 마스킹되지 않은 채 외부로 나간다.
    ordered = sorted(
        candidates,
        key=lambda c: (-GRADE_WEIGHT[c.severity], c.priority, c.start, -c.end),
    )

    accepted: list[Candidate] = []
    for candidate in ordered:
        if not any(_overlaps(existing, candidate) for existing in accepted):
            accepted.append(candidate)

    # 채택은 심각도 순으로 했으므로 토큰 번호와 목록 순서를 위해 본문 순서로 되돌린다.
    return sorted(accepted, key=lambda c: c.start)


def grade_candidates(candidates: Sequence[Candidate]) -> str:
    """가장 높은 등급이 이긴다. 후보가 없으면 일반이다."""
    grade = "normal"
    for candidate in candidates:
        if GRADE_WEIGHT[candidate.severity] > GRADE_WEIGHT[grade]:
            grade = candidate.severity
    return grade


def _utf16_offsets(text: str) -> list[int]:
    """코드 포인트 인덱스 -> UTF-16 코드 단위 인덱스 대응표."""
    table = [0] * (len(text) + 1)
    total = 0
    for index, char in enumerate(text):
        table[index] = total
        total += 2 if ord(char) > 0xFFFF else 1
    table[len(text)] = total
    return table


def build_detections(request_id: str, candidates: Sequence[Candidate], text: str) -> list[dict]:
    """화면 계약(Detection)의 형태로 만든다. 오프셋은 UTF-16 기준으로 환산한다."""
    offsets = _utf16_offsets(text)
    token_counts: dict[str, int] = {}
    detections: list[dict] = []

    for index, candidate in enumerate(candidates):
        count = token_counts.get(candidate.token_label, 0) + 1
        token_counts[candidate.token_label] = count
        detections.append({
            "id": f"{request_id}-d{index + 1}",
            "type": candidate.type,
            "label": candidate.label,
            "start": offsets[candidate.start],
            "end": offsets[candidate.end],
            "masked": f"[{candidate.token_label}{count}]",
            "confidence": candidate.confidence,
        })

    return detections


def mask_text(text: str, candidates: Sequence[Candidate]) -> str:
    """뒤에서부터 치환해 앞 구간의 오프셋이 밀리지 않게 한다."""
    token_counts: dict[str, int] = {}
    tokens: list[tuple[int, int, str]] = []

    for candidate in candidates:
        count = token_counts.get(candidate.token_label, 0) + 1
        token_counts[candidate.token_label] = count
        tokens.append((candidate.start, candidate.end, f"[{candidate.token_label}{count}]"))

    masked = text
    for start, end, token in sorted(tokens, key=lambda item: item[0], reverse=True):
        masked = f"{masked[:start]}{token}{masked[end:]}"
    return masked


_REASON_BOTH = (
    "첨부한 파일의 내용을 확인하지 못했고, 고유식별정보 또는 비밀 키도 함께 있어 전송을 "
    "차단했다. 해당 구간을 지우고 파일을 뺀 뒤 다시 검사하거나 관리자 승인을 요청한다."
)
_REASON_UNREADABLE = (
    "첨부한 파일의 내용을 확인하지 못해 전송을 차단했다. 파일을 빼고 필요한 부분만 "
    "붙여넣거나 관리자 승인을 요청한다."
)
_REASON_OTHER = (
    "고유식별정보 또는 비밀 키가 포함되어 전송을 차단했다. 해당 구간을 지우고 다시 "
    "검사하거나 관리자 승인을 요청한다."
)


def blocked_reason(candidates: Sequence[Candidate], grade: str) -> str:
    if grade != "blocked":
        return ""
    has_unreadable = any(c.type == "unreadable_attachment" for c in candidates)
    has_other = any(
        c.severity == "blocked" and c.type != "unreadable_attachment" for c in candidates
    )
    if has_unreadable and has_other:
        return _REASON_BOTH
    if has_unreadable:
        return _REASON_UNREADABLE
    return _REASON_OTHER


def inspect_text(
    request_id: str,
    text: str,
    entries: Sequence[DictionaryTerm] = (),
    elapsed_ms: int = 0,
) -> dict:
    """검사 한 번의 전체 결과. InspectionResult 계약과 같은 형태다."""
    candidates = find_candidates(text, entries)
    grade = grade_candidates(candidates)
    return {
        "requestId": request_id,
        "grade": grade,
        "route": ROUTE_BY_GRADE[grade],
        "detections": build_detections(request_id, candidates, text),
        "originalText": text,
        "maskedText": mask_text(text, candidates),
        "reason": blocked_reason(candidates, grade),
        "elapsedMs": elapsed_ms,
    }
