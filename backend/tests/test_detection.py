"""탐지·등급 판정이 프런트엔드 목 구현과 같은 답을 내는지 확인한다.

시나리오 G-01~G-04 는 README 의 발표 시연 대본과 같은 입력이다.
여기서 등급이 달라지면 시연이 대본대로 흘러가지 않는다.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.detection import (  # noqa: E402
    DictionaryTerm,
    find_candidates,
    grade_candidates,
    inspect_text,
)

SEED = [
    DictionaryTerm("ABC상사", "partner", "confidential", True),
    DictionaryTerm("대한물산", "partner", "confidential", True),
    DictionaryTerm("한빛테크", "partner", "confidential", True),
]


def grade_of(text: str, entries=SEED) -> str:
    return grade_candidates(find_candidates(text, entries))


def test_g01_normal():
    assert grade_of("회의록 요약 양식을 알려줘") == "normal"


def test_g02_caution():
    text = "홍길동 010-0000-0000 hong@example.com 으로 안내문 보내줘"
    assert grade_of(text) == "caution"


def test_g03_confidential():
    text = "ABC상사 X-100 단가 12,000원 견적 문구 만들어줘"
    assert grade_of(text) == "confidential"


def test_g04_blocked():
    assert grade_of("주민등록번호 000000-0000000 확인해줘") == "blocked"


def test_unreadable_attachment_is_blocked():
    """판정 불가 첨부가 '일반'으로 새어 나가면 안 된다."""
    text = "요약해줘\n--- 첨부1 · 내용을 읽지 못함 ---"
    assert grade_of(text) == "blocked"


def test_highest_grade_wins():
    """낮은 등급이 섞여도 가장 높은 등급이 이긴다(fail-safe)."""
    text = "hong@example.com 과 주민등록번호 000000-0000000"
    assert grade_of(text) == "blocked"


def test_routes_follow_grade():
    assert inspect_text("r1", "회의록 양식", SEED)["route"] == "external_llm"
    assert inspect_text("r2", "010-1234-5678", SEED)["route"] == "masked_external"
    assert inspect_text("r3", "ABC상사 견적", SEED)["route"] == "internal_llm"
    assert inspect_text("r4", "000000-0000000", SEED)["route"] == "blocked"


def test_masking_replaces_every_detection():
    text = "홍길동 010-0000-0000 hong@example.com 으로 안내문 보내줘"
    result = inspect_text("r5", text, SEED)
    masked = result["maskedText"]
    assert "010-0000-0000" not in masked
    assert "hong@example.com" not in masked
    assert "홍길동" not in masked
    assert "[전화1]" in masked and "[이메일1]" in masked and "[이름1]" in masked


def test_token_numbering_increments_per_label():
    text = "010-1111-1111 그리고 010-2222-2222"
    masked = inspect_text("r6", text, SEED)["maskedText"]
    assert "[전화1]" in masked and "[전화2]" in masked


def test_overlap_keeps_higher_grade():
    """주민등록번호 형태는 계좌번호 규칙과 겹칠 수 있다. 높은 등급이 남아야 한다."""
    result = inspect_text("r7", "000000-0000000", SEED)
    assert result["grade"] == "blocked"
    assert [d["label"] for d in result["detections"]] == ["주민등록번호"]


def test_inactive_dictionary_entry_is_ignored():
    entries = [DictionaryTerm("비밀거래처", "partner", "confidential", False)]
    assert grade_of("비밀거래처와 협의", entries) == "normal"


def test_dictionary_entry_added_takes_effect():
    entries = list(SEED) + [DictionaryTerm("X-100", "product_code", "confidential", True)]
    assert grade_of("X-100 재고 알려줘", entries) == "confidential"


def test_blocked_reason_is_present_only_when_blocked():
    assert inspect_text("r8", "회의록 양식", SEED)["reason"] == ""
    assert inspect_text("r9", "000000-0000000", SEED)["reason"] != ""


def test_utf16_offsets_survive_non_bmp_characters():
    """이모지가 앞에 있어도 프런트가 자르는 위치와 같아야 한다."""
    text = "🙂 010-1234-5678"
    result = inspect_text("r10", text, SEED)
    detection = result["detections"][0]
    # 프런트엔드는 UTF-16 기준으로 자른다. 이모지는 2 코드 단위다.
    assert text.encode("utf-16-le").decode("utf-16-le")[0:0] == ""
    sliced = _utf16_slice(text, detection["start"], detection["end"])
    assert sliced == "010-1234-5678"


def _utf16_slice(text: str, start: int, end: int) -> str:
    """자바스크립트의 String.prototype.slice 와 같은 방식으로 자른다."""
    units = text.encode("utf-16-le")
    return units[start * 2:end * 2].decode("utf-16-le")
