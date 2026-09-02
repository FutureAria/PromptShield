# PromptShield 프론트엔드

생성형 AI에 입력할 문장을 외부 전송 전에 검사하고, 민감도에 따라 그대로 전달·마스킹·사내 LLM 처리·차단 경로를 보여 주는 React 데모입니다. 백엔드 없이 목 API만으로 직원 화면과 관리자 화면의 전체 흐름을 재현합니다.

## 실행 방법

Node.js 20 이상과 npm이 필요합니다.

```bash
npm install
npm run dev
```

개발 서버는 `http://localhost:3000`에서 실행됩니다.

```bash
npx tsc --noEmit  # strict TypeScript 검사
npm run build     # dist/ 프로덕션 빌드
npm test          # Vitest 시나리오 테스트
```

## 화면

- `/`: 직원용 AI 채팅과 검사 결과 대조 화면
- `/admin`: 승인 대기를 먼저 보여 주는 관리자 대시보드
- `/admin/logs`: 원문을 저장하거나 표시하지 않는 감사 로그
- `/admin/approvals`: 승인·마스킹본 조건부 승인·반려 처리

## 목 API 구조

- `src/api/types.ts`: 팀 공통 API 계약
- `src/api/mock.ts`: 정규식 탐지, 오프셋 기반 마스킹, 가짜 AI 응답, 감사 로그와 승인 대기 데이터
- `src/api/index.ts`: 화면이 참조하는 API 진입점

`inspect`, `send`, `requestApproval`, `reportFalsePositive`, `getDashboard`, `getAuditLogs`, `getPendingApprovals`, `decideApproval`을 모두 Promise 기반으로 제공하며 실제 환경과 비슷하게 지연됩니다. 테스트에서는 `setMockDelayRange`로 지연을 줄일 수 있습니다. 목 데이터는 메모리에 있으므로 페이지를 새로 열면 초기 상태로 돌아갑니다.

## 실제 백엔드로 교체하기

1. `src/api/types.ts` 계약을 사용하는 `src/api/real.ts`를 만들고 같은 8개 함수를 `fetch`로 구현합니다.
2. 검사 결과의 `start`와 `end`는 JavaScript 문자열 오프셋 기준으로 전달합니다. `end`는 해당 구간 다음 위치입니다.
3. `src/api/index.ts`의 export 대상을 `./mock`에서 `./real`로 바꿉니다. 화면 코드는 API 진입점만 참조하므로 수정할 필요가 없습니다.
4. 감사 로그 응답에는 원문이나 실제 탐지 값을 추가하지 않습니다. 유형별 건수만 전달합니다.

## 시연 입력

| 시나리오 | 입력 | 기대 결과 |
|---|---|---|
| G-01 정상 전송 | `회의록 요약 양식을 알려줘` | 일반 · 그대로 전송 |
| G-02 마스킹 후 전송 | `홍길동 010-0000-0000 hong@example.com 으로 안내문 보내줘` | 주의 · 이름/전화/이메일을 가린 뒤 전송 |
| G-03 내부 LLM 처리 | `ABC상사 X-100 단가 12,000원 견적 문구 만들어줘` | 기밀 · 외부 전송 없이 사내 LLM 처리 |
| G-04 전송 차단 | `주민등록번호 000000-0000000 확인해줘` | 위험 · 전송 차단 또는 관리자 승인 요청 |

모든 입력은 시연을 위한 명백한 더미이며 실제 개인정보를 넣지 않습니다.
