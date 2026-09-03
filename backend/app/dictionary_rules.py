"""기업 사전 초안 검증.

frontend/src/api/dictionary.ts 의 validateDraft 와 같은 판정을 낸다.
저장 전에 서버에서도 같은 검사를 해야 화면을 우회한 요청을 막을 수 있다.
"""

from __future__ import annotations

import re

DICTIONARY_ACTIVE_LIMIT = 300
DICTIONARY_PASTE_ROW_LIMIT = 200

_NUMERIC_ONLY = re.compile(r"^[\d,.\-]+$")

# 낱말만 겹치는 정상 업무 문장. 초안 사전이 여기 걸리면 오탐 예고다.
# 첫 문장은 시연 G-01 의 입력과 같다.
FALSE_POSITIVE_PROBE = (
    "회의록 요약 양식을 알려줘",
    "주민등록등본 발급 절차를 정리해줘",
    "이번 분기 매출 보고서 목차를 잡아줘",
    "신규 입사자 온보딩 안내문 초안을 써줘",
)


def _issue(row_id: str, field: str, level: str, code: str, message: str) -> dict:
    return {"rowId": row_id, "field": field, "level": level, "code": code, "message": message}


def validate_draft(draft: list[dict], saved: list[dict]) -> list[dict]:
    issues: list[dict] = []
    active_terms: set[str] = set()

    for row in draft:
        row_id = row.get("rowId", "")
        term = (row.get("term") or "").strip()
        note = (row.get("note") or "").strip()

        if len(term) == 0:
            issues.append(_issue(row_id, "term", "error", "term_empty", "용어를 입력한다."))
        elif len(term) == 1:
            issues.append(_issue(
                row_id, "term", "error", "term_too_short",
                "한 글자 용어는 문장 곳곳에 걸려 오탐을 만든다. 두 글자 이상으로 적는다.",
            ))
        elif len(term) == 2:
            issues.append(_issue(
                row_id, "term", "warning", "term_short_warning",
                "두 글자 용어는 무관한 문장에도 걸릴 수 있다. 아래 시험 검사로 확인한다.",
            ))
        elif len(term) > 40:
            issues.append(_issue(
                row_id, "term", "error", "term_too_long",
                "40자를 넘는 용어는 완전 일치하는 일이 거의 없다. 짧은 핵심어로 나눈다.",
            ))

        if term and _NUMERIC_ONLY.match(term):
            issues.append(_issue(
                row_id, "term", "warning", "term_numeric_only",
                "숫자만으로 된 용어는 무관한 수치에도 걸린다.",
            ))

        if row.get("active") and term:
            if term in active_terms:
                issues.append(_issue(
                    row_id, "term", "error", "term_duplicate", "이미 등록된 용어다.",
                ))
            else:
                active_terms.add(term)

            if any(
                (not entry.get("active")) and entry.get("term") == term
                and entry.get("id") != row.get("id")
                for entry in saved
            ):
                issues.append(_issue(
                    row_id, "term", "warning", "term_inactive_exists",
                    "같은 용어가 비활성 상태로 있다. 새로 추가하는 대신 다시 활성화할 수 있다.",
                ))

        if len(note) > 100:
            issues.append(_issue(
                row_id, "note", "error", "note_too_long", "메모는 100자까지 적는다.",
            ))

    if sum(1 for row in draft if row.get("active")) > DICTIONARY_ACTIVE_LIMIT:
        issues.append(_issue(
            "total", "total", "error", "active_limit",
            "활성 항목이 상한 300건을 넘었다. 쓰지 않는 항목을 비활성화한다.",
        ))

    return issues


def has_error(issues: list[dict]) -> bool:
    return any(issue["level"] == "error" for issue in issues)
