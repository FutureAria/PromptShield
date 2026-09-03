"""데이터 구조.

원문 취급 원칙
--------------
원문(prompt 본문)은 `inspections.original_text` 한 곳에만 둔다. 소유자 본인이
자기 검사 결과를 다시 볼 때와, 승인 뒤 실제 전송할 때만 읽는다. 전송이 끝나거나
보관 시간이 지나면 지운다. 감사 로그·승인 대기·역할 변경 기록에는 원문도, 탐지된
값도 넣지 않는다. 관리 화면이 새 유출 경로가 되면 안 된다는 것이 이 프로젝트의
설계 원칙이고, 개인정보 최소 수집·보관 원칙과도 같은 방향이다.
"""

from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import (
    Boolean, DateTime, Float, ForeignKey, Integer, JSON, String, Text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class User(Base):
    __tablename__ = "users"

    user_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    name: Mapped[str] = mapped_column(String(64), nullable=False)
    department: Mapped[str] = mapped_column(String(64), nullable=False)
    role: Mapped[str] = mapped_column(String(16), nullable=False)
    description: Mapped[str] = mapped_column(String(200), default="")


class AuthSession(Base):
    """서버가 발급하는 세션. 권한 판정의 최종 근거다."""

    __tablename__ = "auth_sessions"

    token: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.user_id"), nullable=False, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    user: Mapped[User] = relationship()


class Inspection(Base):
    __tablename__ = "inspections"

    request_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    owner_user_id: Mapped[str | None] = mapped_column(String(64), index=True)
    grade: Mapped[str] = mapped_column(String(16), nullable=False)
    route: Mapped[str] = mapped_column(String(24), nullable=False)
    # 원문. 소유자 본인과 전송 처리에서만 읽고, 전송·해제·만료 시 None 이 된다.
    original_text: Mapped[str | None] = mapped_column(Text)
    masked_text: Mapped[str] = mapped_column(Text, nullable=False)
    reason: Mapped[str] = mapped_column(Text, default="")
    detections: Mapped[list] = mapped_column(JSON, default=list)
    elapsed_ms: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)


class Approval(Base):
    """위험 등급 요청에 대한 1회용 허가.

    consumed_at 이 채워진 승인으로는 같은 요청을 다시 전송할 수 없다.
    """

    __tablename__ = "approvals"

    approval_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    request_id: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    requester_user_id: Mapped[str] = mapped_column(String(64), nullable=False)
    state: Mapped[str] = mapped_column(String(16), nullable=False, default="pending")
    requested_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    decided_by: Mapped[str | None] = mapped_column(String(64))
    rejection_reason: Mapped[str | None] = mapped_column(Text)
    consumed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # 승인자에게 보여 줄 미리보기. 마스킹된 상태만 저장한다.
    masked_preview: Mapped[str] = mapped_column(Text, default="")
    detection_summary: Mapped[list] = mapped_column(JSON, default=list)
    reason: Mapped[str] = mapped_column(Text, default="")


class AuditLog(Base):
    """감사 로그. 원문도, 탐지된 값도 넣지 않는다. 유형별 건수만 남긴다."""

    __tablename__ = "audit_logs"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
    user_name: Mapped[str] = mapped_column(String(64), nullable=False)
    department: Mapped[str] = mapped_column(String(64), nullable=False)
    grade: Mapped[str] = mapped_column(String(16), nullable=False, index=True)
    route: Mapped[str] = mapped_column(String(24), nullable=False)
    detection_counts: Mapped[list] = mapped_column(JSON, default=list)
    approved_by: Mapped[str | None] = mapped_column(String(64))


class DictionaryEntry(Base):
    """기업 사전.

    사람 이름·연락처·고유식별정보는 넣지 않는다. 사전 표가 개인정보 파일이 되면
    관리 화면이 새 유출 경로가 된다. 이름 탐지는 별도 탐지 규칙이 담당한다.
    """

    __tablename__ = "dictionary_entries"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    term: Mapped[str] = mapped_column(String(120), nullable=False)
    entry_type: Mapped[str] = mapped_column(String(24), nullable=False)
    grade: Mapped[str] = mapped_column(String(16), nullable=False)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    note: Mapped[str] = mapped_column(String(300), default="")
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_by: Mapped[str] = mapped_column(String(64), default="")
    sort_order: Mapped[int] = mapped_column(Integer, default=0)


class DictionaryMeta(Base):
    """사전 전체의 판(revision). 저장할 때마다 1 증가한다."""

    __tablename__ = "dictionary_meta"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, default=1)
    revision: Mapped[int] = mapped_column(Integer, default=1)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class RoleChange(Base):
    """계정 상태 변화만 남긴다. 프롬프트 원문·탐지 값을 넣지 않는다."""

    __tablename__ = "role_changes"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
    actor_name: Mapped[str] = mapped_column(String(64), nullable=False)
    target_name: Mapped[str] = mapped_column(String(64), nullable=False)
    from_role: Mapped[str] = mapped_column(String(16), nullable=False)
    to_role: Mapped[str] = mapped_column(String(16), nullable=False)


class FalsePositiveReport(Base):
    """오탐 신고. 같은 요청의 같은 탐지는 한 번만 센다."""

    __tablename__ = "false_positive_reports"

    id: Mapped[str] = mapped_column(String(160), primary_key=True)  # requestId + detectionId
    request_id: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    detection_id: Mapped[str] = mapped_column(String(64), nullable=False)
    reported_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    confidence: Mapped[float] = mapped_column(Float, default=0.0)
