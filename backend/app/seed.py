"""초기 데이터.

데모 계정과 씨앗 사전은 프런트엔드 목 구현과 값이 같아야 한다.
값이 하나라도 달라지면 시연 대본 G-03 과 감사 로그의 '거래처' 라벨 집계가 어긋난다.
"""

from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from .models import DictionaryEntry, DictionaryMeta, User

SEED_UPDATED_AT = datetime(2026, 8, 25, 2, 0, 0, tzinfo=timezone.utc)

DEMO_ACCOUNTS = [
    ("emp-hong", "홍길동", "영업팀", "employee", "업무 요청을 보내는 일반 직원"),
    ("emp-kim", "김철수", "생산관리팀", "employee", "업무 요청을 보내는 일반 직원"),
    ("sec-park", "박보안", "정보보안팀", "approver", "위험 요청의 승인·반려를 처리한다"),
    ("aud-lee", "이감사", "감사팀", "auditor", "감사 로그를 조회한다. 승인 처리는 할 수 없다"),
]

SEED_TERMS = ["ABC상사", "대한물산", "한빛테크"]


def seed_if_empty(db: Session) -> None:
    if db.scalar(select(User).limit(1)) is None:
        for user_id, name, department, role, description in DEMO_ACCOUNTS:
            db.add(User(
                user_id=user_id, name=name, department=department,
                role=role, description=description,
            ))

    if db.scalar(select(DictionaryEntry).limit(1)) is None:
        for index, term in enumerate(SEED_TERMS):
            db.add(DictionaryEntry(
                id=f"dict-seed-{index + 1}",
                term=term,
                entry_type="partner",
                grade="confidential",
                active=True,
                note="",
                updated_at=SEED_UPDATED_AT,
                updated_by="초기 설정",
                sort_order=index,
            ))

    if db.scalar(select(DictionaryMeta).limit(1)) is None:
        db.add(DictionaryMeta(id=1, revision=1, updated_at=SEED_UPDATED_AT))

    db.commit()
