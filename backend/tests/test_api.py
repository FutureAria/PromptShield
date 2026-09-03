"""API 전체 흐름 검증.

시연 대본(README 발표 시연 대본)이 실제로 그대로 흘러가는지 확인한다.
등급 판정 → 전송 경로 → 승인 왕복 → 사전 반영 → 감사 로그까지 한 번에 본다.
"""

import os
import tempfile
from pathlib import Path

_TMP = Path(tempfile.mkdtemp(prefix="promptshield-test-"))
os.environ["DATABASE_URL"] = f"sqlite+pysqlite:///{_TMP / 'test.db'}"
os.environ["SEED_DEMO_DATA"] = "1"
os.environ["EXTERNAL_LLM_ENABLED"] = "0"
# 내부 LLM 은 테스트에서 뜨지 않는다. 연결 실패 시 스텁으로 떨어지는 경로를 함께 본다.
os.environ["OLLAMA_BASE_URL"] = "http://127.0.0.1:9"

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as test_client:
        yield test_client


def token_for(client, user_id: str) -> str:
    response = client.post("/api/auth/login", json={"userId": user_id})
    assert response.status_code == 200, response.text
    return response.json()["token"]


def auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


# ── 인증과 권한 ─────────────────────────────────────────────────────────

def test_demo_accounts_are_seeded(client):
    accounts = client.get("/api/accounts").json()
    assert [a["userId"] for a in accounts] == ["emp-hong", "emp-kim", "sec-park", "aud-lee"]
    assert [a["role"] for a in accounts] == ["employee", "employee", "approver", "auditor"]


def test_protected_route_rejects_missing_token(client):
    assert client.get("/api/dashboard").status_code == 401


def test_employee_cannot_reach_admin_routes(client):
    """프런트 라우트 가드를 우회해 직접 호출해도 서버가 막아야 한다."""
    headers = auth(token_for(client, "emp-hong"))
    for path in ("/api/dashboard", "/api/audit-logs", "/api/approvals/pending",
                 "/api/dictionary", "/api/users"):
        assert client.get(path, headers=headers).status_code == 403, path


def test_auditor_cannot_decide_or_edit(client):
    """감사자는 조회만 한다. 승인 처리와 사전 편집은 막힌다."""
    headers = auth(token_for(client, "aud-lee"))
    assert client.get("/api/audit-logs", headers=headers).status_code == 200
    assert client.get("/api/dictionary", headers=headers).status_code == 200
    assert client.put("/api/dictionary", json={"draft": []}, headers=headers).status_code == 403
    decision = client.post(
        "/api/approvals/none/decision", json={"decision": "approved"}, headers=headers,
    )
    assert decision.status_code == 403


# ── 시연 대본 G-01 ~ G-04 ───────────────────────────────────────────────

@pytest.mark.parametrize("text,grade,route", [
    ("회의록 요약 양식을 알려줘", "normal", "external_llm"),
    ("홍길동 010-0000-0000 hong@example.com 으로 안내문 보내줘", "caution", "masked_external"),
    ("ABC상사 X-100 단가 12,000원 견적 문구 만들어줘", "confidential", "internal_llm"),
    ("주민등록번호 000000-0000000 확인해줘", "blocked", "blocked"),
])
def test_demo_scenarios_grade_and_route(client, text, grade, route):
    headers = auth(token_for(client, "emp-hong"))
    result = client.post("/api/inspect", json={"text": text}, headers=headers).json()
    assert result["grade"] == grade
    assert result["route"] == route


def test_caution_masks_every_detected_value(client):
    headers = auth(token_for(client, "emp-hong"))
    text = "홍길동 010-0000-0000 hong@example.com 으로 안내문 보내줘"
    result = client.post("/api/inspect", json={"text": text}, headers=headers).json()
    masked = result["maskedText"]
    assert "010-0000-0000" not in masked
    assert "hong@example.com" not in masked
    assert "홍길동" not in masked


def test_unreadable_attachment_is_blocked(client):
    headers = auth(token_for(client, "emp-hong"))
    text = "요약해줘\n--- 첨부1 · 내용을 읽지 못함 ---"
    result = client.post("/api/inspect", json={"text": text}, headers=headers).json()
    assert result["grade"] == "blocked"
    assert result["reason"]


# ── 전송 ────────────────────────────────────────────────────────────────

def test_normal_request_sends(client):
    headers = auth(token_for(client, "emp-hong"))
    inspection = client.post(
        "/api/inspect", json={"text": "회의록 요약 양식을 알려줘"}, headers=headers,
    ).json()
    message = client.post(
        f"/api/inspections/{inspection['requestId']}/send", headers=headers,
    )
    assert message.status_code == 200, message.text
    body = message.json()
    assert body["role"] == "assistant"
    assert body["route"] == "external_llm"


def test_blocked_request_cannot_send_without_approval(client):
    headers = auth(token_for(client, "emp-hong"))
    inspection = client.post(
        "/api/inspect", json={"text": "주민등록번호 000000-0000000 확인해줘"}, headers=headers,
    ).json()
    response = client.post(
        f"/api/inspections/{inspection['requestId']}/send", headers=headers,
    )
    assert response.status_code == 403
    assert "승인" in response.json()["detail"]


def test_same_request_cannot_be_sent_twice(client):
    headers = auth(token_for(client, "emp-hong"))
    inspection = client.post(
        "/api/inspect", json={"text": "분기 보고서 목차를 잡아줘"}, headers=headers,
    ).json()
    request_id = inspection["requestId"]
    assert client.post(f"/api/inspections/{request_id}/send", headers=headers).status_code == 200
    assert client.post(f"/api/inspections/{request_id}/send", headers=headers).status_code == 409


def test_other_user_cannot_read_inspection(client):
    """남의 검사 결과에는 원문이 들어 있다. 다른 계정이 읽으면 안 된다."""
    hong = auth(token_for(client, "emp-hong"))
    kim = auth(token_for(client, "emp-kim"))
    inspection = client.post(
        "/api/inspect", json={"text": "회의록 양식 알려줘"}, headers=hong,
    ).json()
    response = client.get(f"/api/inspections/{inspection['requestId']}", headers=kim)
    assert response.status_code == 403


# ── 승인 왕복 ───────────────────────────────────────────────────────────

def test_approval_round_trip_is_single_use(client):
    """직원 요청 → 승인자 조건부 승인 → 직원 전송 → 재전송 차단."""
    employee = auth(token_for(client, "emp-hong"))
    approver = auth(token_for(client, "sec-park"))

    inspection = client.post(
        "/api/inspect", json={"text": "주민등록번호 111111-1111111 처리해줘"}, headers=employee,
    ).json()
    request_id = inspection["requestId"]
    assert inspection["grade"] == "blocked"

    requested = client.post(f"/api/inspections/{request_id}/approval", headers=employee)
    assert requested.status_code == 200
    approval_id = requested.json()["approvalId"]
    assert requested.json()["status"] == "pending"

    pending = client.get("/api/approvals/pending", headers=approver).json()
    assert any(item["id"] == approval_id for item in pending)

    # ★ 승인 대기 목록에 원문이 새어 나가면 안 된다.
    entry = next(item for item in pending if item["id"] == approval_id)
    assert "111111-1111111" not in entry["maskedPreview"]

    decided = client.post(
        f"/api/approvals/{approval_id}/decision",
        json={"decision": "conditional"}, headers=approver,
    )
    assert decided.status_code == 200, decided.text

    status = client.get(f"/api/inspections/{request_id}/approval", headers=employee).json()
    assert status["state"] == "conditional"

    sent = client.post(f"/api/inspections/{request_id}/send", headers=employee)
    assert sent.status_code == 200, sent.text
    assert sent.json()["route"] == "masked_external"

    # 1회용 허가다. 같은 승인으로 다시 보낼 수 없다.
    again = client.post(f"/api/inspections/{request_id}/send", headers=employee)
    assert again.status_code == 409


def test_rejection_requires_reason(client):
    employee = auth(token_for(client, "emp-hong"))
    approver = auth(token_for(client, "sec-park"))
    inspection = client.post(
        "/api/inspect", json={"text": "주민등록번호 222222-2222222"}, headers=employee,
    ).json()
    request_id = inspection["requestId"]
    approval_id = client.post(
        f"/api/inspections/{request_id}/approval", headers=employee,
    ).json()["approvalId"]

    blank = client.post(
        f"/api/approvals/{approval_id}/decision",
        json={"decision": "rejected", "reason": "   "}, headers=approver,
    )
    assert blank.status_code == 400

    ok = client.post(
        f"/api/approvals/{approval_id}/decision",
        json={"decision": "rejected", "reason": "고유식별정보는 외부 전송 불가"}, headers=approver,
    )
    assert ok.status_code == 200
    assert client.post(
        f"/api/inspections/{request_id}/send", headers=employee,
    ).status_code == 403


# ── 감사 로그 ───────────────────────────────────────────────────────────

def test_audit_log_never_carries_original_text(client):
    """감사 로그가 새 유출 경로가 되면 안 된다는 것이 이 프로젝트의 설계 원칙이다."""
    employee = auth(token_for(client, "emp-hong"))
    auditor = auth(token_for(client, "aud-lee"))
    secret = "333333-3333333"
    client.post("/api/inspect", json={"text": f"주민등록번호 {secret}"}, headers=employee)

    logs = client.get("/api/audit-logs", headers=auditor).json()
    assert logs, "차단 자체가 보안 사건이므로 감사 로그에 남아야 한다"
    serialized = repr(logs)
    assert secret not in serialized
    for entry in logs:
        assert "originalText" not in entry and "maskedText" not in entry
        for item in entry["detectionCounts"]:
            assert set(item) == {"label", "count"}


def test_audit_log_grade_filter(client):
    auditor = auth(token_for(client, "aud-lee"))
    logs = client.get("/api/audit-logs?grade=blocked", headers=auditor).json()
    assert logs
    assert all(entry["grade"] == "blocked" for entry in logs)


def test_dashboard_reports_counts(client):
    approver = auth(token_for(client, "sec-park"))
    summary = client.get("/api/dashboard", headers=approver).json()
    assert set(summary["byGrade"]) == {"normal", "caution", "confidential", "blocked"}
    assert len(summary["blockedTrend"]) == 14
    assert summary["byGrade"]["blocked"] > 0


# ── 기업 사전 ───────────────────────────────────────────────────────────

def test_dictionary_addition_changes_later_inspection(client):
    """관리자가 제품코드를 추가하면 이후 검사에 반영된다. 시연 5단계다."""
    approver = auth(token_for(client, "sec-park"))
    employee = auth(token_for(client, "emp-kim"))

    before = client.post("/api/inspect", json={"text": "X-100 재고 알려줘"}, headers=employee).json()
    assert before["grade"] == "normal"

    snapshot = client.get("/api/dictionary", headers=approver).json()
    draft = [
        {"rowId": f"r{i}", "id": e["id"], "term": e["term"], "entryType": e["entryType"],
         "grade": e["grade"], "active": e["active"], "note": e["note"]}
        for i, e in enumerate(snapshot["entries"])
    ]
    draft.append({
        "rowId": "new", "term": "X-100", "entryType": "product_code",
        "grade": "confidential", "active": True, "note": "제품코드",
    })

    check = client.post("/api/dictionary/check", json={"draft": draft}, headers=approver).json()
    assert not [issue for issue in check["issues"] if issue["level"] == "error"]

    saved = client.put(
        "/api/dictionary",
        json={"draft": draft, "baseRevision": snapshot["revision"]}, headers=approver,
    )
    assert saved.status_code == 200, saved.text
    assert saved.json()["revision"] == snapshot["revision"] + 1

    after = client.post("/api/inspect", json={"text": "X-100 재고 알려줘"}, headers=employee).json()
    assert after["grade"] == "confidential"
    assert after["route"] == "internal_llm"


def test_dictionary_rejects_one_character_term(client):
    approver = auth(token_for(client, "sec-park"))
    draft = [{"rowId": "r1", "term": "가", "entryType": "partner",
              "grade": "confidential", "active": True, "note": ""}]
    check = client.post("/api/dictionary/check", json={"draft": draft}, headers=approver).json()
    assert any(issue["code"] == "term_too_short" for issue in check["issues"])
    assert client.put(
        "/api/dictionary", json={"draft": draft}, headers=approver,
    ).status_code == 422


def test_dictionary_warns_about_false_positives(client):
    """정상 업무 문장에 걸리는 사전은 저장 전에 예고한다."""
    approver = auth(token_for(client, "sec-park"))
    draft = [{"rowId": "r1", "term": "회의록", "entryType": "other",
              "grade": "caution", "active": True, "note": ""}]
    check = client.post("/api/dictionary/check", json={"draft": draft}, headers=approver).json()
    assert check["falsePositiveHits"]
    assert check["falsePositiveHits"][0]["matched"] == "회의록"


def test_dictionary_stale_revision_is_rejected(client):
    approver = auth(token_for(client, "sec-park"))
    snapshot = client.get("/api/dictionary", headers=approver).json()
    draft = [
        {"rowId": f"r{i}", "id": e["id"], "term": e["term"], "entryType": e["entryType"],
         "grade": e["grade"], "active": e["active"], "note": e["note"]}
        for i, e in enumerate(snapshot["entries"])
    ]
    stale = client.put(
        "/api/dictionary",
        json={"draft": draft, "baseRevision": snapshot["revision"] - 1}, headers=approver,
    )
    assert stale.status_code == 409


def test_preview_is_not_stored_and_not_sendable(client):
    approver = auth(token_for(client, "sec-park"))
    preview = client.post(
        "/api/dictionary/preview",
        json={"text": "ABC상사 견적", "draft": []}, headers=approver,
    ).json()
    assert preview["saved"]["requestId"].startswith("preview-")
    assert preview["gradeChanged"] is True  # 초안이 비어 있으니 기밀 → 일반
    employee = auth(token_for(client, "emp-hong"))
    assert client.post(
        f"/api/inspections/{preview['saved']['requestId']}/send", headers=employee,
    ).status_code == 404


# ── 사용자 · 권한 ────────────────────────────────────────────────────────

def test_cannot_change_own_role(client):
    approver = auth(token_for(client, "sec-park"))
    response = client.put("/api/users/sec-park/role", json={"role": "employee"}, headers=approver)
    assert response.status_code == 400


def test_cannot_remove_last_approver(client):
    """승인자가 한 명뿐일 때 강등하면 되돌릴 사람이 없어진다."""
    approver = auth(token_for(client, "sec-park"))
    directory = client.get("/api/users", headers=approver).json()
    assert directory["roleCounts"]["approver"] == 1

    promoted = client.put("/api/users/emp-kim/role", json={"role": "approver"}, headers=approver)
    assert promoted.status_code == 200
    assert promoted.json()["role"] == "approver"

    demoted = client.put("/api/users/emp-kim/role", json={"role": "employee"}, headers=approver)
    assert demoted.status_code == 200

    changes = client.get("/api/role-changes", headers=approver).json()
    assert changes[0]["targetName"] == "김철수"
    assert changes[0]["from"] == "approver" and changes[0]["to"] == "employee"


def test_role_change_invalidates_existing_session(client):
    """역할이 바뀐 계정의 낡은 세션으로 계속 쓸 수 없어야 한다."""
    approver = auth(token_for(client, "sec-park"))
    victim_token = token_for(client, "emp-kim")
    assert client.get("/api/auth/session", headers=auth(victim_token)).status_code == 200

    client.put("/api/users/emp-kim/role", json={"role": "auditor"}, headers=approver)
    assert client.get("/api/auth/session", headers=auth(victim_token)).status_code == 401

    client.put("/api/users/emp-kim/role", json={"role": "employee"}, headers=approver)


def test_grade_policy_matches_contract(client):
    rows = client.get("/api/grade-policy").json()
    assert [row["grade"] for row in rows] == ["normal", "caution", "confidential", "blocked"]
    assert [row["route"] for row in rows] == [
        "external_llm", "masked_external", "internal_llm", "blocked",
    ]
