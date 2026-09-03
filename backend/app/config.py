"""실행 설정. 값은 환경변수로 주입한다."""

from __future__ import annotations

import os
from dataclasses import dataclass


def _flag(name: str, default: bool = False) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class Settings:
    database_url: str = os.getenv("DATABASE_URL", "sqlite+pysqlite:///./promptshield.db")

    # 내부 LLM. 기밀 등급은 이 경로로만 처리한다.
    ollama_base_url: str = os.getenv("OLLAMA_BASE_URL", "http://ollama:11434")
    ollama_model: str = os.getenv("OLLAMA_MODEL", "qwen2.5:3b")

    # 외부 LLM. 기본값은 꺼져 있다. 켜지 않으면 스텁 응답을 돌려준다.
    # 지정되지 않은 원격 엔드포인트로 사내 데이터가 나가는 것을 기본 동작으로 두지 않는다.
    external_llm_enabled: bool = _flag("EXTERNAL_LLM_ENABLED", False)
    external_llm_url: str = os.getenv("EXTERNAL_LLM_URL", "")
    external_llm_model: str = os.getenv("EXTERNAL_LLM_MODEL", "")

    llm_timeout_seconds: float = float(os.getenv("LLM_TIMEOUT_SECONDS", "20"))

    # 원문 보관 시간. 검사 뒤 이 시간이 지나면 원문을 지운다.
    # 판정 결과와 감사 로그는 남고 원문만 사라진다.
    original_text_ttl_seconds: int = int(os.getenv("ORIGINAL_TEXT_TTL_SECONDS", "3600"))

    # 접속기록 보존 기간. 개인정보의 안전성 확보조치 기준 제8조를 따른다.
    audit_log_retention_days: int = int(os.getenv("AUDIT_LOG_RETENTION_DAYS", "730"))

    seed_demo_data: bool = _flag("SEED_DEMO_DATA", True)


settings = Settings()
