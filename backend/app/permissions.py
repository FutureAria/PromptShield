"""역할별 권한.

★ 이 표가 서버 쪽 유일한 정의다. frontend/src/api/permissions.ts 와 값이 같아야 한다.
   프런트엔드의 역할 검사는 편의이지 보안 경계가 아니다. 최종 판정은 여기서 한다.
"""

from __future__ import annotations

CAPABILITY_MATRIX: dict[str, dict[str, bool]] = {
    "employee.inspect":       {"employee": True,  "approver": True,  "auditor": True},
    "admin.dashboard.view":   {"employee": False, "approver": True,  "auditor": True},
    "admin.demo.reset":       {"employee": False, "approver": True,  "auditor": False},
    "admin.logs.view":        {"employee": False, "approver": True,  "auditor": True},
    "admin.approvals.view":   {"employee": False, "approver": True,  "auditor": True},
    "admin.approvals.decide": {"employee": False, "approver": True,  "auditor": False},
    "admin.dictionary.view":  {"employee": False, "approver": True,  "auditor": True},
    "admin.dictionary.edit":  {"employee": False, "approver": True,  "auditor": False},
    "admin.users.view":       {"employee": False, "approver": True,  "auditor": True},
    "admin.users.assign":     {"employee": False, "approver": True,  "auditor": False},
}

ROLE_ORDER = ("employee", "approver", "auditor")
ROLE_LABELS = {"employee": "직원", "approver": "승인자", "auditor": "감사자"}


def can(role: str, capability: str) -> bool:
    return CAPABILITY_MATRIX[capability].get(role, False)
