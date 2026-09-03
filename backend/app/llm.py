"""LLM 연동.

경로별 원칙
-----------
- internal_llm : 기밀 등급. Ollama 로만 처리한다. 외부로 나가지 않는다.
- external_llm : 일반 등급 또는 관리자 전체 승인. 기본값은 꺼져 있다.
- masked_external : 주의 등급 또는 조건부 승인. 마스킹본만 보낸다.
- blocked : 아무 데도 보내지 않는다.

외부 LLM 은 EXTERNAL_LLM_ENABLED 를 켜고 주소를 지정해야만 실제로 호출한다.
지정되지 않은 원격 주소로 사내 데이터가 나가는 것을 기본 동작으로 두지 않기 위해서다.
꺼져 있으면 호출 없이 스텁 문구를 돌려주고, 그 사실을 응답에 밝힌다.
"""

from __future__ import annotations

import logging

import httpx

from .config import settings

logger = logging.getLogger(__name__)

_STUB_BY_ROUTE = {
    "external_llm": (
        "요청한 내용을 확인했다. 핵심 항목을 기준으로 간결하게 정리해 활용할 수 있다."
    ),
    "masked_external": (
        "민감정보를 마스킹한 전송본으로 처리했다. 원문 값은 외부 LLM에 전달하지 않았다."
    ),
    "internal_llm": (
        "사내 LLM에서 처리했다. 이 요청은 외부로 전송되지 않았다. "
        "내부 자료의 맥락을 유지해 답변을 준비했다."
    ),
    "blocked": "전송이 차단된 요청이다.",
}

_INTERNAL_UNAVAILABLE = (
    "사내 LLM(Ollama)에 연결하지 못해 임시 응답을 표시한다. "
    "이 요청은 외부로 전송되지 않았다. 관리자에게 사내 LLM 상태 확인을 요청한다."
)

_EXTERNAL_DISABLED_SUFFIX = (
    " (외부 LLM 연동이 꺼져 있어 실제 호출 없이 예시 응답을 표시한다.)"
)


def stub_for_route(route: str) -> str:
    return _STUB_BY_ROUTE.get(route, _STUB_BY_ROUTE["blocked"])


async def _call_ollama(prompt: str) -> str | None:
    url = f"{settings.ollama_base_url.rstrip('/')}/api/generate"
    payload = {"model": settings.ollama_model, "prompt": prompt, "stream": False}
    try:
        async with httpx.AsyncClient(timeout=settings.llm_timeout_seconds) as client:
            response = await client.post(url, json=payload)
            response.raise_for_status()
            body = response.json()
    except Exception as error:  # 연결 실패·타임아웃·모델 없음 모두 같은 방식으로 처리한다.
        logger.warning("Ollama 호출 실패: %s", error)
        return None

    text = (body.get("response") or "").strip()
    return text or None


async def _call_external(prompt: str) -> str | None:
    if not settings.external_llm_enabled or not settings.external_llm_url:
        return None
    payload = {"model": settings.external_llm_model, "prompt": prompt, "stream": False}
    try:
        async with httpx.AsyncClient(timeout=settings.llm_timeout_seconds) as client:
            response = await client.post(settings.external_llm_url, json=payload)
            response.raise_for_status()
            body = response.json()
    except Exception as error:
        logger.warning("외부 LLM 호출 실패: %s", error)
        return None

    text = (body.get("response") or "").strip()
    return text or None


async def generate(route: str, prompt: str) -> tuple[str, bool]:
    """(응답 문구, 실제 모델이 답했는가) 를 돌려준다.

    두 번째 값이 False 면 모델을 부르지 않았거나 부르지 못한 것이다.
    화면과 감사 기록이 '모델이 답한 것'과 '스텁'을 구분할 수 있어야 한다.
    """
    if route == "blocked":
        return stub_for_route(route), False

    if route == "internal_llm":
        answer = await _call_ollama(prompt)
        if answer is None:
            return _INTERNAL_UNAVAILABLE, False
        return answer, True

    # external_llm, masked_external
    answer = await _call_external(prompt)
    if answer is None:
        return stub_for_route(route) + _EXTERNAL_DISABLED_SUFFIX, False
    return answer, True
