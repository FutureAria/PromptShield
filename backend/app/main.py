"""PromptShield 게이트웨이 백엔드.

프런트엔드(frontend/src/api)가 정한 계약을 그대로 제공한다. 응답 필드 이름은
TypeScript 계약과 같은 camelCase 다.

권한 판정은 서버에서 한다. 프런트엔드의 라우트 가드는 시연 편의이지 보안 경계가
아니다. 모든 관리 경로는 세션 토큰의 역할을 다시 확인한다.
"""

from __future__ import annotations

import secrets
import time
from collections import Counter
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone

from fastapi import Depends, FastAPI, Header, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from . import detection as det
from .config import settings
from .db import Base, engine, get_db
from .dictionary_rules import (
    DICTIONARY_ACTIVE_LIMIT,
    FALSE_POSITIVE_PROBE,
    has_error,
    validate_draft,
)
from .llm import generate
from .models import (
    Approval, AuditLog, AuthSession, DictionaryEntry, DictionaryMeta,
    FalsePositiveReport, Inspection, RoleChange, User, utcnow,
)
from .permissions import ROLE_LABELS, can
from .seed import DEMO_ACCOUNTS, seed_if_empty

APPROVAL_PREVIEW_LIMIT = 500


def iso(value: datetime | None) -> str | None:
    """자바스크립트 Date.toISOString() 과 같은 모양으로 만든다."""
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    utc = value.astimezone(timezone.utc)
    return f"{utc.strftime('%Y-%m-%dT%H:%M:%S')}.{utc.microsecond // 1000:03d}Z"


def new_id(prefix: str) -> str:
    return f"{prefix}-{secrets.token_hex(8)}"


@asynccontextmanager
async def lifespan(_: FastAPI):
    Base.metadata.create_all(bind=engine)
    if settings.seed_demo_data:
        from .db import SessionLocal
        db = SessionLocal()
        try:
            seed_if_empty(db)
        finally:
            db.close()
    yield


app = FastAPI(title="PromptShield Gateway", version="1.0.0", lifespan=lifespan)

# 개발 서버(:3000)에서 붙을 때만 필요하다. 배포 구성에서는 Nginx 가 같은 출처로 묶는다.
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"http://(localhost|127\.0\.0\.1)(:\d+)?",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── 인증 ────────────────────────────────────────────────────────────────

def current_user(
    db: Session = Depends(get_db),
    authorization: str | None = Header(default=None),
) -> User:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="로그인이 필요하다.")
    token = authorization.split(" ", 1)[1].strip()
    session = db.get(AuthSession, token)
    if session is None:
        raise HTTPException(status_code=401, detail="세션이 만료되었다. 다시 로그인한다.")
    user = db.get(User, session.user_id)
    if user is None:
        raise HTTPException(status_code=401, detail="계정을 찾을 수 없다.")
    return user


def require(user: User, capability: str, message: str) -> None:
    if not can(user.role, capability):
        raise HTTPException(status_code=403, detail=message)


def session_payload(user: User) -> dict:
    return {
        "userId": user.user_id,
        "name": user.name,
        "department": user.department,
        "role": user.role,
    }


class LoginBody(BaseModel):
    userId: str


@app.get("/api/health")
def health() -> dict:
    return {"status": "ok"}


@app.get("/api/accounts")
def list_demo_accounts(db: Session = Depends(get_db)) -> list[dict]:
    users = db.scalars(select(User)).all()
    order = {"emp-hong": 0, "emp-kim": 1, "sec-park": 2, "aud-lee": 3}
    users = sorted(users, key=lambda u: order.get(u.user_id, 99))
    return [{**session_payload(u), "description": u.description} for u in users]


@app.post("/api/auth/login")
def login(body: LoginBody, db: Session = Depends(get_db)) -> dict:
    user = db.get(User, body.userId)
    if user is None:
        raise HTTPException(status_code=404, detail="계정을 찾을 수 없다.")
    token = secrets.token_urlsafe(32)
    db.add(AuthSession(token=token, user_id=user.user_id))
    db.commit()
    return {"token": token, "session": session_payload(user)}


@app.post("/api/auth/logout")
def logout(db: Session = Depends(get_db), authorization: str | None = Header(default=None)) -> dict:
    if authorization and authorization.lower().startswith("bearer "):
        token = authorization.split(" ", 1)[1].strip()
        db.execute(delete(AuthSession).where(AuthSession.token == token))
        db.commit()
    return {"ok": True}


@app.get("/api/auth/session")
def read_session(user: User = Depends(current_user)) -> dict:
    return session_payload(user)


# ── 사전 조회 도우미 ─────────────────────────────────────────────────────

def active_terms(db: Session) -> list[det.DictionaryTerm]:
    rows = db.scalars(
        select(DictionaryEntry).order_by(DictionaryEntry.sort_order, DictionaryEntry.id)
    ).all()
    return [
        det.DictionaryTerm(r.term, r.entry_type, r.grade, r.active)
        for r in rows if r.active
    ]


def entry_payload(row: DictionaryEntry) -> dict:
    return {
        "id": row.id,
        "term": row.term,
        "entryType": row.entry_type,
        "grade": row.grade,
        "active": row.active,
        "note": row.note,
        "updatedAt": iso(row.updated_at),
        "updatedBy": row.updated_by,
    }


# ── 검사 ────────────────────────────────────────────────────────────────

class InspectBody(BaseModel):
    text: str = Field(default="")


def inspection_payload(row: Inspection) -> dict:
    return {
        "requestId": row.request_id,
        "grade": row.grade,
        "route": row.route,
        "detections": row.detections or [],
        # 원문이 만료·삭제되었으면 마스킹본으로 대체한다. 화면은 계약상 문자열을 기대한다.
        "originalText": row.original_text if row.original_text is not None else row.masked_text,
        "maskedText": row.masked_text,
        "reason": row.reason or "",
        "elapsedMs": row.elapsed_ms,
    }


def summarize(detections: list[dict]) -> list[dict]:
    counts = Counter(d["label"] for d in detections)
    return [{"label": label, "count": count} for label, count in counts.items()]


def write_audit(
    db: Session, *, user_name: str, department: str, grade: str, route: str,
    detection_counts: list[dict], approved_by: str | None = None,
) -> None:
    """감사 로그를 남긴다. 원문도, 탐지된 값도 넣지 않는다. 유형별 건수만 남긴다."""
    db.add(AuditLog(
        id=new_id("REQ"), at=utcnow(), user_name=user_name, department=department,
        grade=grade, route=route, detection_counts=detection_counts, approved_by=approved_by,
    ))


def purge_expired_originals(db: Session) -> None:
    """보관 시간이 지난 원문을 지운다. 판정 결과와 감사 로그는 남는다."""
    cutoff = utcnow() - timedelta(seconds=settings.original_text_ttl_seconds)
    stale = db.scalars(
        select(Inspection).where(
            Inspection.original_text.is_not(None), Inspection.created_at < cutoff
        )
    ).all()
    for row in stale:
        row.original_text = None


@app.post("/api/inspect")
def inspect(
    body: InspectBody, db: Session = Depends(get_db), user: User = Depends(current_user),
) -> dict:
    require(user, "employee.inspect", "검사 권한이 없다.")
    purge_expired_originals(db)

    request_id = new_id("req")
    started = time.perf_counter()
    result = det.inspect_text(request_id, body.text, active_terms(db))
    result["elapsedMs"] = int((time.perf_counter() - started) * 1000)

    # 같은 사용자의 이전 활성 검사는 내려놓는다. 활성 검사는 한 번에 하나다.
    for previous in db.scalars(
        select(Inspection).where(
            Inspection.owner_user_id == user.user_id, Inspection.is_active.is_(True)
        )
    ).all():
        previous.is_active = False

    db.add(Inspection(
        request_id=request_id, owner_user_id=user.user_id,
        grade=result["grade"], route=result["route"],
        original_text=body.text, masked_text=result["maskedText"],
        reason=result["reason"], detections=result["detections"],
        elapsed_ms=result["elapsedMs"], is_active=True,
    ))

    # 차단은 그 자체가 보안 사건이다. 전송되지 않아 send 기록이 남지 않으므로 여기서 남긴다.
    if result["grade"] == "blocked":
        write_audit(
            db, user_name=user.name, department=user.department,
            grade="blocked", route="blocked",
            detection_counts=summarize(result["detections"]),
        )

    db.commit()
    return result


@app.get("/api/inspections/active")
def get_active_inspection(
    db: Session = Depends(get_db), user: User = Depends(current_user),
) -> dict | None:
    row = db.scalar(
        select(Inspection).where(
            Inspection.owner_user_id == user.user_id, Inspection.is_active.is_(True)
        ).order_by(Inspection.created_at.desc())
    )
    return inspection_payload(row) if row else None


@app.delete("/api/inspections/active/{request_id}")
def clear_active_inspection(
    request_id: str, db: Session = Depends(get_db), user: User = Depends(current_user),
) -> dict:
    row = db.get(Inspection, request_id)
    if row and row.owner_user_id == user.user_id:
        row.is_active = False
        # 화면에서 내려놓은 검사의 원문은 곧바로 지운다.
        row.original_text = None
        db.commit()
    return {"ok": True}


@app.get("/api/inspections/{request_id}")
def get_inspection(
    request_id: str, db: Session = Depends(get_db), user: User = Depends(current_user),
) -> dict | None:
    row = db.get(Inspection, request_id)
    if row is None:
        return None
    # 남의 검사 결과는 돌려주지 않는다. 원문이 다른 계정으로 새어 나가면 안 된다.
    if row.owner_user_id != user.user_id:
        raise HTTPException(status_code=403, detail="다른 사용자의 검사 결과는 볼 수 없다.")
    return inspection_payload(row)


class FalsePositiveBody(BaseModel):
    detectionId: str


@app.post("/api/inspections/{request_id}/false-positive")
def report_false_positive(
    request_id: str, body: FalsePositiveBody,
    db: Session = Depends(get_db), user: User = Depends(current_user),
) -> dict:
    row = db.get(Inspection, request_id)
    if row is None or row.owner_user_id != user.user_id:
        raise HTTPException(status_code=404, detail="신고할 탐지 항목을 찾을 수 없다.")
    match = next((d for d in (row.detections or []) if d["id"] == body.detectionId), None)
    if match is None:
        raise HTTPException(status_code=404, detail="신고할 탐지 항목을 찾을 수 없다.")

    key = f"{request_id}:{body.detectionId}"
    if db.get(FalsePositiveReport, key) is None:
        db.add(FalsePositiveReport(
            id=key, request_id=request_id, detection_id=body.detectionId,
            confidence=float(match.get("confidence", 0.0)),
        ))
        db.commit()
    return {"reported": True}


# ── 전송 ────────────────────────────────────────────────────────────────

@app.post("/api/inspections/{request_id}/send")
async def send(
    request_id: str, db: Session = Depends(get_db), user: User = Depends(current_user),
) -> dict:
    require(user, "employee.inspect", "전송 권한이 없다.")
    row = db.get(Inspection, request_id)
    if row is None or row.owner_user_id != user.user_id:
        raise HTTPException(status_code=404, detail="검사 결과를 찾을 수 없다. 내용을 다시 검사해 달라.")
    if row.sent_at is not None:
        raise HTTPException(status_code=409, detail="이미 전송한 요청이다. 내용을 다시 검사해 달라.")

    route = row.route
    override_text: str | None = None

    if row.grade == "blocked":
        approval = db.scalar(
            select(Approval).where(Approval.request_id == request_id)
            .order_by(Approval.requested_at.desc())
        )
        if approval is None or approval.state == "pending":
            raise HTTPException(status_code=403, detail="관리자 승인 전에는 전송할 수 없다.")
        if approval.state == "rejected":
            raise HTTPException(status_code=403, detail="관리자가 반려한 요청이다.")
        if approval.consumed_at is not None:
            raise HTTPException(
                status_code=409,
                detail="이미 전송에 사용한 승인이다. 내용을 다시 검사해 승인을 요청해 달라.",
            )

        # 승인은 1회용이므로 모델을 부르기 전에 소모 처리한다.
        # 응답을 기다린 뒤 기록하면 연속 호출이 둘 다 검사를 통과해 중복 전송된다.
        approval.consumed_at = utcnow()
        db.flush()

        if approval.state == "approved":
            route = "external_llm"
            override_text = "관리자 승인에 따라 원문을 외부 LLM으로 전송해 처리했다."
        else:
            route = "masked_external"
            override_text = (
                "관리자의 조건부 승인에 따라 민감정보를 마스킹한 전송본으로 처리했다. "
                "원문 값은 외부 LLM에 전달하지 않았다."
            )

    # 어떤 문장을 실제로 모델에 넘기는가. 이것이 이 시스템의 핵심 결정이다.
    # 마스킹 경로에는 원문이 아니라 마스킹본만 넘긴다.
    outgoing = row.masked_text if route == "masked_external" else (row.original_text or row.masked_text)

    answer, from_model = await generate(route, outgoing)
    if override_text is not None and not from_model:
        answer = override_text

    row.sent_at = utcnow()
    row.is_active = False
    # 전송이 끝난 요청의 원문은 더 들고 있을 이유가 없다.
    row.original_text = None

    write_audit(
        db, user_name=user.name, department=user.department,
        grade=row.grade, route=route,
        detection_counts=summarize(row.detections or []),
    )
    db.commit()

    return {
        "id": new_id("message"),
        "role": "assistant",
        "text": answer,
        "route": route,
    }


# ── 승인 ────────────────────────────────────────────────────────────────

def approval_status_payload(approval: Approval) -> dict:
    payload = {
        "approvalId": approval.approval_id,
        "requestId": approval.request_id,
        "state": approval.state,
        "requestedAt": iso(approval.requested_at),
    }
    if approval.decided_at:
        payload["decidedAt"] = iso(approval.decided_at)
    if approval.decided_by:
        payload["decidedBy"] = approval.decided_by
    if approval.state == "rejected" and approval.rejection_reason:
        payload["rejectionReason"] = approval.rejection_reason
    if approval.consumed_at:
        payload["consumedAt"] = iso(approval.consumed_at)
    return payload


@app.post("/api/inspections/{request_id}/approval")
def request_approval(
    request_id: str, db: Session = Depends(get_db), user: User = Depends(current_user),
) -> dict:
    row = db.get(Inspection, request_id)
    if row is None or row.owner_user_id != user.user_id:
        raise HTTPException(status_code=404, detail="검사 결과를 찾을 수 없다. 내용을 다시 검사해 달라.")
    if row.grade != "blocked":
        raise HTTPException(status_code=400, detail="관리자 승인은 위험 등급 요청에서만 요청할 수 있다.")

    existing = db.scalar(
        select(Approval).where(Approval.request_id == request_id)
        .order_by(Approval.requested_at.desc())
    )
    if existing is not None:
        if existing.state == "pending":
            return {"approvalId": existing.approval_id, "status": "pending"}
        raise HTTPException(
            status_code=409, detail="이미 처리된 승인 요청이다. 내용을 수정한 후 다시 검사해 달라.",
        )

    # 첨부가 붙으면 마스킹본이 수만 자가 되어 승인 대기 표가 터진다. 마스킹본이라 원문 값은
    # 없지만, 마스킹되지 않은 나머지 본문 전체가 관리자에게 그대로 보이는 문제가 남는다.
    masked = row.masked_text
    preview = masked if len(masked) <= APPROVAL_PREVIEW_LIMIT else (
        f"{masked[:APPROVAL_PREVIEW_LIMIT]}… 생략 {len(masked) - APPROVAL_PREVIEW_LIMIT}자"
    )

    approval = Approval(
        approval_id=new_id("approval"), request_id=request_id,
        requester_user_id=user.user_id, state="pending", requested_at=utcnow(),
        masked_preview=preview, detection_summary=summarize(row.detections or []),
        reason=row.reason or "정책상 관리자 확인이 필요한 요청이다.",
    )
    db.add(approval)
    db.commit()
    return {"approvalId": approval.approval_id, "status": "pending"}


@app.get("/api/inspections/{request_id}/approval")
def get_approval_status(
    request_id: str, db: Session = Depends(get_db), user: User = Depends(current_user),
) -> dict | None:
    approval = db.scalar(
        select(Approval).where(Approval.request_id == request_id)
        .order_by(Approval.requested_at.desc())
    )
    if approval is None:
        return None
    if approval.requester_user_id != user.user_id and not can(user.role, "admin.approvals.view"):
        raise HTTPException(status_code=403, detail="이 승인 상태를 볼 권한이 없다.")
    return approval_status_payload(approval)


@app.get("/api/approvals/pending")
def list_pending_approvals(
    db: Session = Depends(get_db), user: User = Depends(current_user),
) -> list[dict]:
    require(user, "admin.approvals.view", "승인 대기 목록을 볼 권한이 없다.")
    rows = db.scalars(
        select(Approval).where(Approval.state == "pending")
        .order_by(Approval.requested_at.desc())
    ).all()

    result = []
    for approval in rows:
        requester = db.get(User, approval.requester_user_id)
        result.append({
            "id": approval.approval_id,
            "requestId": approval.request_id,
            "at": iso(approval.requested_at),
            "userName": requester.name if requester else "알 수 없음",
            "department": requester.department if requester else "",
            "reason": approval.reason,
            "detectionSummary": approval.detection_summary or [],
            "maskedPreview": approval.masked_preview,
        })
    return result


class DecisionBody(BaseModel):
    decision: str
    reason: str | None = None


@app.post("/api/approvals/{approval_id}/decision")
def decide_approval(
    approval_id: str, body: DecisionBody,
    db: Session = Depends(get_db), user: User = Depends(current_user),
) -> dict:
    require(user, "admin.approvals.decide", "승인 처리 권한이 없다.")
    if body.decision not in {"approved", "conditional", "rejected"}:
        raise HTTPException(status_code=400, detail="알 수 없는 결정이다.")

    approval = db.get(Approval, approval_id)
    if approval is None or approval.state != "pending":
        raise HTTPException(status_code=404, detail="이미 처리되었거나 찾을 수 없는 승인 요청이다.")
    if body.decision == "rejected" and not (body.reason or "").strip():
        raise HTTPException(status_code=400, detail="반려하는 이유를 입력해 달라.")

    approval.state = body.decision
    approval.decided_at = utcnow()
    approval.decided_by = user.name
    if body.decision == "rejected":
        approval.rejection_reason = (body.reason or "").strip()

    requester = db.get(User, approval.requester_user_id)
    route = {
        "approved": "external_llm",
        "conditional": "masked_external",
        "rejected": "blocked",
    }[body.decision]
    write_audit(
        db,
        user_name=requester.name if requester else "알 수 없음",
        department=requester.department if requester else "",
        grade="blocked", route=route,
        detection_counts=approval.detection_summary or [],
        approved_by=user.name,
    )
    db.commit()
    return {"id": approval_id, "decision": body.decision, "status": "decided"}


# ── 감사 로그 · 현황 ─────────────────────────────────────────────────────

@app.get("/api/audit-logs")
def get_audit_logs(
    grade: str = Query(default="all"),
    from_: str | None = Query(default=None, alias="from"),
    to: str | None = Query(default=None),
    search: str | None = Query(default=None),
    db: Session = Depends(get_db), user: User = Depends(current_user),
) -> list[dict]:
    require(user, "admin.logs.view", "감사 로그를 조회할 권한이 없다.")

    stmt = select(AuditLog).order_by(AuditLog.at.desc())
    if grade and grade != "all":
        stmt = stmt.where(AuditLog.grade == grade)
    rows = db.scalars(stmt).all()

    def in_range(row: AuditLog) -> bool:
        at = iso(row.at) or ""
        if from_ and at < from_:
            return False
        if to and at > to:
            return False
        return True

    needle = (search or "").strip().lower()

    def matches(row: AuditLog) -> bool:
        if not needle:
            return True
        haystack = f"{row.user_name} {row.department} {row.approved_by or ''}".lower()
        return needle in haystack

    return [
        {
            "id": row.id,
            "at": iso(row.at),
            "userName": row.user_name,
            "department": row.department,
            "grade": row.grade,
            "route": row.route,
            "detectionCounts": row.detection_counts or [],
            **({"approvedBy": row.approved_by} if row.approved_by else {}),
        }
        for row in rows if in_range(row) and matches(row)
    ]


@app.get("/api/dashboard")
def get_dashboard(db: Session = Depends(get_db), user: User = Depends(current_user)) -> dict:
    require(user, "admin.dashboard.view", "관리 현황을 볼 권한이 없다.")
    rows = db.scalars(select(AuditLog)).all()

    by_grade = {"normal": 0, "caution": 0, "confidential": 0, "blocked": 0}
    detection_counter: Counter[str] = Counter()
    for row in rows:
        if row.grade in by_grade:
            by_grade[row.grade] += 1
        for item in row.detection_counts or []:
            detection_counter[item["label"]] += item["count"]

    today = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    trend = []
    for offset in range(13, -1, -1):
        day = today - timedelta(days=offset)
        next_day = day + timedelta(days=1)
        count = sum(
            1 for row in rows
            if row.grade == "blocked"
            and day <= (row.at if row.at.tzinfo else row.at.replace(tzinfo=timezone.utc)) < next_day
        )
        trend.append({"date": day.strftime("%Y-%m-%d"), "count": count})

    pending = len(db.scalars(select(Approval).where(Approval.state == "pending")).all())
    reports = len(db.scalars(select(FalsePositiveReport)).all())

    return {
        "byGrade": by_grade,
        "blockedTrend": trend,
        "byDetectionType": [
            {"label": label, "count": count}
            for label, count in detection_counter.most_common()
        ],
        "pendingCount": pending,
        "falsePositiveReports": reports,
    }


@app.get("/api/grade-policy")
def get_grade_policy() -> list[dict]:
    employee_action = {
        "normal": "경고 없이 그대로 전송한다",
        "caution": "민감 구간을 번호 토큰으로 가린 전송본을 보낸다",
        "confidential": "외부로 나가지 않고 사내에서 처리한다",
        "blocked": "전송 버튼이 잠기고 승인 요청 경로만 열린다",
    }
    return [
        {"grade": grade, "route": det.ROUTE_BY_GRADE[grade], "employeeAction": employee_action[grade]}
        for grade in ("normal", "caution", "confidential", "blocked")
    ]


# ── 기업 사전 ────────────────────────────────────────────────────────────

def dictionary_snapshot(db: Session) -> dict:
    meta = db.get(DictionaryMeta, 1)
    rows = db.scalars(
        select(DictionaryEntry).order_by(DictionaryEntry.sort_order, DictionaryEntry.id)
    ).all()
    return {
        "revision": meta.revision if meta else 1,
        "updatedAt": iso(meta.updated_at) if meta else iso(utcnow()),
        "entries": [entry_payload(row) for row in rows],
        "activeLimit": DICTIONARY_ACTIVE_LIMIT,
    }


@app.get("/api/dictionary")
def get_dictionary(db: Session = Depends(get_db), user: User = Depends(current_user)) -> dict:
    require(user, "admin.dictionary.view", "기업 사전을 조회할 권한이 없다.")
    return dictionary_snapshot(db)


class DraftBody(BaseModel):
    draft: list[dict] = Field(default_factory=list)


def draft_terms(draft: list[dict]) -> list[det.DictionaryTerm]:
    terms = []
    for row in draft:
        term = (row.get("term") or "").strip()
        if not term or not row.get("active"):
            continue
        terms.append(det.DictionaryTerm(
            term, row.get("entryType", "partner"), row.get("grade", "confidential"), True,
        ))
    return terms


@app.post("/api/dictionary/check")
def check_dictionary_draft(
    body: DraftBody, db: Session = Depends(get_db), user: User = Depends(current_user),
) -> dict:
    require(user, "admin.dictionary.view", "기업 사전을 조회할 권한이 없다.")
    saved = [entry_payload(r) for r in db.scalars(select(DictionaryEntry)).all()]
    issues = validate_draft(body.draft, saved)

    # 정상 업무 문장에 초안 사전이 걸리면 오탐 예고다.
    hits = []
    for sentence in FALSE_POSITIVE_PROBE:
        for row in body.draft:
            term = (row.get("term") or "").strip()
            if not term or not row.get("active") or term not in sentence:
                continue
            preset = det.DICTIONARY_PRESETS.get(row.get("entryType", "partner"))
            hits.append({
                "sentence": sentence,
                "rowId": row.get("rowId", ""),
                "label": preset["label"] if preset else "사내 용어",
                "matched": term,
            })

    active_count = sum(1 for row in body.draft if row.get("active"))
    return {
        "issues": issues,
        "falsePositiveHits": hits,
        "activeCount": active_count,
        "activeLimit": DICTIONARY_ACTIVE_LIMIT,
    }


class PreviewBody(BaseModel):
    text: str = Field(default="")
    # 생략하면 저장된 사전으로만 검사한다. 이때 차이(deltas)는 없다.
    draft: list[dict] | None = None


@app.post("/api/dictionary/preview")
def preview_inspection(
    body: PreviewBody, db: Session = Depends(get_db), user: User = Depends(current_user),
) -> dict:
    require(user, "admin.dictionary.view", "기업 사전을 조회할 권한이 없다.")

    # ★ 시험 검사 결과는 저장하지 않는다. requestId 가 preview- 로 시작하며 전송할 수 없다.
    #   입력은 관리자가 방금 타이핑한 원문이므로 감사 로그에도 남기지 않는다.
    saved_terms = active_terms(db)
    saved_result = det.inspect_text("preview-saved", body.text, saved_terms)
    if body.draft is None:
        draft_result = det.inspect_text("preview-draft", body.text, saved_terms)
        return {
            "saved": saved_result, "draft": draft_result,
            "deltas": [], "gradeChanged": False,
        }
    draft_result = det.inspect_text("preview-draft", body.text, draft_terms(body.draft))

    def key(item: dict) -> tuple:
        return (item["start"], item["end"])

    saved_map = {key(d): d for d in saved_result["detections"]}
    draft_map = {key(d): d for d in draft_result["detections"]}

    deltas = []
    for k, d in draft_map.items():
        matched = det_slice(body.text, d["start"], d["end"])
        if k not in saved_map:
            deltas.append({
                "kind": "added", "label": d["label"], "matched": matched,
                "start": d["start"], "end": d["end"],
            })
        elif saved_map[k]["label"] != d["label"]:
            deltas.append({
                "kind": "relabeled", "label": d["label"],
                "previousLabel": saved_map[k]["label"], "matched": matched,
                "start": d["start"], "end": d["end"],
            })
    for k, d in saved_map.items():
        if k not in draft_map:
            deltas.append({
                "kind": "removed", "label": d["label"],
                "matched": det_slice(body.text, d["start"], d["end"]),
                "start": d["start"], "end": d["end"],
            })

    deltas.sort(key=lambda item: item["start"])
    return {
        "saved": saved_result,
        "draft": draft_result,
        "deltas": deltas,
        "gradeChanged": saved_result["grade"] != draft_result["grade"],
    }


def det_slice(text: str, start: int, end: int) -> str:
    """UTF-16 오프셋으로 자른다. 탐지 결과의 start/end 와 같은 기준이다."""
    units = text.encode("utf-16-le")
    return units[start * 2:end * 2].decode("utf-16-le", errors="ignore")


class SaveDictionaryBody(BaseModel):
    draft: list[dict] = Field(default_factory=list)
    baseRevision: int | None = None


@app.put("/api/dictionary")
def save_dictionary(
    body: SaveDictionaryBody, db: Session = Depends(get_db), user: User = Depends(current_user),
) -> dict:
    require(user, "admin.dictionary.edit", "기업 사전을 고칠 권한이 없다.")

    saved = [entry_payload(r) for r in db.scalars(select(DictionaryEntry)).all()]
    issues = validate_draft(body.draft, saved)
    if has_error(issues):
        raise HTTPException(status_code=422, detail={"issues": issues})

    meta = db.get(DictionaryMeta, 1)
    if meta is None:
        meta = DictionaryMeta(id=1, revision=1, updated_at=utcnow())
        db.add(meta)
        db.flush()

    # 다른 관리자가 먼저 저장했으면 덮어쓰지 않는다.
    if body.baseRevision is not None and body.baseRevision != meta.revision:
        raise HTTPException(
            status_code=409,
            detail="다른 관리자가 먼저 저장했다. 최신 사전을 불러온 뒤 다시 시도한다.",
        )

    now = utcnow()
    keep_ids: set[str] = set()
    for order, row in enumerate(body.draft):
        term = (row.get("term") or "").strip()
        if not term:
            continue
        entry_id = row.get("id")
        existing = db.get(DictionaryEntry, entry_id) if entry_id else None
        changed = (
            existing is None
            or existing.term != term
            or existing.entry_type != row.get("entryType")
            or existing.grade != row.get("grade")
            or existing.active != bool(row.get("active"))
            or existing.note != (row.get("note") or "").strip()
        )
        if existing is None:
            existing = DictionaryEntry(id=new_id("dict"))
            db.add(existing)
        existing.term = term
        existing.entry_type = row.get("entryType", "partner")
        existing.grade = row.get("grade", "confidential")
        existing.active = bool(row.get("active"))
        existing.note = (row.get("note") or "").strip()
        existing.sort_order = order
        if changed:
            existing.updated_at = now
            existing.updated_by = user.name
        keep_ids.add(existing.id)

    for row in db.scalars(select(DictionaryEntry)).all():
        if row.id not in keep_ids:
            db.delete(row)

    meta.revision += 1
    meta.updated_at = now
    db.commit()
    return dictionary_snapshot(db)


# ── 사용자 · 권한 ────────────────────────────────────────────────────────

def build_directory(db: Session, viewer: User) -> dict:
    users = db.scalars(select(User)).all()
    role_counts = {"employee": 0, "approver": 0, "auditor": 0}
    for u in users:
        role_counts[u.role] = role_counts.get(u.role, 0) + 1

    logs = db.scalars(select(AuditLog)).all()

    def last_active(name: str) -> str | None:
        stamps = [
            iso(row.at) for row in logs
            if row.user_name == name or row.approved_by == name
        ]
        return max(stamps) if stamps else None

    rank = {"approver": 0, "auditor": 1, "employee": 2}
    ordered = sorted(users, key=lambda u: (rank.get(u.role, 9), u.name))

    payload = []
    for u in ordered:
        stamp = last_active(u.name)
        payload.append({
            "userId": u.user_id,
            "name": u.name,
            "department": u.department,
            "role": u.role,
            **({"lastActiveAt": stamp} if stamp else {}),
            "isCurrentUser": u.user_id == viewer.user_id,
        })

    pending = len(db.scalars(select(Approval).where(Approval.state == "pending")).all())
    return {
        "users": payload,
        "roleCounts": role_counts,
        "pendingApprovalCount": pending,
        "canAssign": can(viewer.role, "admin.users.assign"),
    }


@app.get("/api/users")
def list_users(db: Session = Depends(get_db), user: User = Depends(current_user)) -> dict:
    require(user, "admin.users.view", "사용자·권한을 조회할 권한이 없다.")
    return build_directory(db, user)


class AssignRoleBody(BaseModel):
    role: str


@app.put("/api/users/{user_id}/role")
def assign_role(
    user_id: str, body: AssignRoleBody,
    db: Session = Depends(get_db), user: User = Depends(current_user),
) -> dict:
    require(user, "admin.users.assign", "역할을 배정할 권한이 없다.")
    if body.role not in ROLE_LABELS:
        raise HTTPException(status_code=400, detail="알 수 없는 역할이다.")

    target = db.get(User, user_id)
    if target is None:
        raise HTTPException(status_code=404, detail="대상 계정을 찾을 수 없다.")

    # 화면에도 같은 규칙이 있지만 최종 판정은 서버가 한다.
    if target.user_id == user.user_id:
        raise HTTPException(
            status_code=400,
            detail="본인 계정의 역할은 스스로 바꿀 수 없다. 다른 승인자에게 요청한다.",
        )

    if target.role == body.role:
        return next(u for u in build_directory(db, user)["users"] if u["userId"] == user_id)

    if target.role == "approver":
        approvers = len(db.scalars(select(User).where(User.role == "approver")).all())
        if approvers <= 1:
            raise HTTPException(
                status_code=409,
                detail=(
                    f"승인자가 {target.name} 한 명뿐이다. 지금 강등하면 위험 요청을 처리할 사람이"
                    " 없어지고 역할을 되돌릴 수 있는 사람도 없어진다."
                    " 먼저 다른 직원을 승인자로 올린 뒤 다시 시도한다."
                ),
            )

    previous = target.role
    target.role = body.role
    db.add(RoleChange(
        id=new_id("rolechange"), at=utcnow(), actor_name=user.name,
        target_name=target.name, from_role=previous, to_role=body.role,
    ))
    # 역할이 바뀐 계정의 기존 세션은 무효화한다. 낡은 권한으로 계속 쓰지 못하게 한다.
    db.execute(delete(AuthSession).where(AuthSession.user_id == target.user_id))
    db.commit()

    return next(u for u in build_directory(db, user)["users"] if u["userId"] == user_id)


@app.get("/api/role-changes")
def list_role_changes(
    limit: int = Query(default=5, ge=1, le=100),
    db: Session = Depends(get_db), user: User = Depends(current_user),
) -> list[dict]:
    require(user, "admin.users.view", "사용자·권한을 조회할 권한이 없다.")
    rows = db.scalars(
        select(RoleChange).order_by(RoleChange.at.desc()).limit(limit)
    ).all()
    return [
        {
            "id": row.id, "at": iso(row.at), "actorName": row.actor_name,
            "targetName": row.target_name, "from": row.from_role, "to": row.to_role,
        }
        for row in rows
    ]


# ── 시연 초기화 ─────────────────────────────────────────────────────────

@app.post("/api/demo/reset")
def reset_demo_state(db: Session = Depends(get_db), user: User = Depends(current_user)) -> dict:
    require(user, "admin.demo.reset", "시연 초기화 권한이 없다.")

    # 검사·승인·로그만 지운다. 계정과 세션은 남긴다.
    # 발표 도중 초기화했다고 발표자가 로그아웃되면 시연이 끊긴다.
    for model in (FalsePositiveReport, RoleChange, AuditLog, Approval, Inspection):
        db.execute(delete(model))
    db.execute(delete(DictionaryEntry))
    db.execute(delete(DictionaryMeta))

    # 역할이 바뀐 계정을 씨앗 값으로 되돌린다.
    for user_id, name, department, role, description in DEMO_ACCOUNTS:
        account = db.get(User, user_id)
        if account is None:
            db.add(User(
                user_id=user_id, name=name, department=department,
                role=role, description=description,
            ))
        else:
            account.name = name
            account.department = department
            account.role = role
            account.description = description
    db.commit()

    seed_if_empty(db)
    return {"ok": True}
