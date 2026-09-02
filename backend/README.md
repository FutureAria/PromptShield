# backend

FastAPI 기반 게이트웨이 백엔드 예정 영역입니다. 민감정보 탐지(주빈), Ollama 내부 LLM 연동(서연), 데이터보안·DB(재창) 담당입니다.

아직 애플리케이션 소스와 Dockerfile이 없습니다. 이 때문에 기본 `docker compose up`에서는 backend, db, ollama를 제외하며 프런트엔드 시연 환경만 안전하게 실행합니다. db와 ollama는 현재 사용하는 코드가 없고, Ollama 모델은 내려받을 때 수 GB를 사용할 수 있습니다.

백엔드 구현 이후 전체 환경은 저장소 루트에서 다음과 같이 실행합니다.

```sh
docker compose --profile full up
```

현재는 위 명령의 backend 빌드가 실패하는 것이 예상된 상태입니다.
