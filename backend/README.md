# backend

FastAPI 기반 게이트웨이 백엔드. 프런트엔드(`frontend/src/api`)가 정한 계약을 그대로 제공한다.

민감정보 탐지(주빈), Ollama 내부 LLM 연동(서연), 데이터보안·DB(재창) 담당 영역이 여기서 만난다.

## 구성

| 파일 | 역할 |
|---|---|
| `app/detection.py` | 민감정보 탐지와 등급 판정. 프런트 목 구현과 같은 답을 내야 한다 |
| `app/main.py` | API 전체. 검사·전송·승인·감사 로그·기업 사전·사용자 권한 |
| `app/models.py` | PostgreSQL 데이터 구조 9개 |
| `app/permissions.py` | 역할별 권한 표. 서버 쪽 최종 판정 근거 |
| `app/dictionary_rules.py` | 기업 사전 초안 검증 |
| `app/llm.py` | 사내 Ollama·외부 LLM 연동 |
| `app/seed.py` | 데모 계정과 씨앗 사전 |

## 실행

저장소 루트에서 전체 구성을 띄우는 것이 기본이다.

```bash
docker compose up
```

백엔드만 따로 돌리려면 SQLite로 띄운다.

```bash
python -m venv .venv
.venv/bin/pip install -r requirements-dev.txt
.venv/bin/python -m uvicorn app.main:app --port 8000
```

`DATABASE_URL` 을 주지 않으면 `./promptshield.db` (SQLite)를 쓴다.

## 검증

```bash
.venv/bin/python -m pytest tests/ -q
```

탐지 규칙 14개와 API 전체 흐름 28개, 모두 42개다.

## 설계에서 지켜야 하는 것

- **감사 로그·승인 화면에 원문과 탐지된 값을 넣지 않는다.** 관리 화면이 새 유출 경로가 되면 안 된다
- **원문은 `inspections.original_text` 한 곳에만 둔다.** 작성자 본인만 읽고, 전송이 끝나면 지운다
- **권한은 서버가 판정한다.** 프런트의 역할 가드는 시연 편의이지 보안 경계가 아니다
- **승인은 1회용이다.** `consumed_at` 이 찍힌 승인으로 다시 전송할 수 없다
- **탐지 규칙을 고치면 `frontend/src/api/mock.ts` 도 함께 고친다.** 두 곳이 어긋나면 시연 등급이 달라진다
- **외부 LLM 은 기본적으로 꺼져 있다.** `EXTERNAL_LLM_ENABLED` 를 켜야만 호출한다

## 환경변수

| 이름 | 기본값 | 설명 |
|---|---|---|
| `DATABASE_URL` | SQLite 파일 | PostgreSQL 사용 시 `postgresql+psycopg://…` |
| `OLLAMA_BASE_URL` | `http://ollama:11434` | 사내 LLM 주소 |
| `OLLAMA_MODEL` | `qwen2.5:3b` | 사내 LLM 모델 |
| `EXTERNAL_LLM_ENABLED` | `0` | 외부 LLM 호출 허용 여부 |
| `ORIGINAL_TEXT_TTL_SECONDS` | `3600` | 원문 보관 시간 |
| `SEED_DEMO_DATA` | `1` | 데모 계정·씨앗 사전 생성 |
