export type Grade = 'normal' | 'caution' | 'confidential' | 'blocked'
export type Route = 'external_llm' | 'internal_llm' | 'masked_external' | 'blocked'
export type DetectionType =
  | 'rrn' | 'phone' | 'email' | 'account'
  | 'partner' | 'price' | 'source_code' | 'api_key'

export type UserRole = 'employee' | 'approver' | 'auditor'

export interface Session {
  userId: string
  name: string
  department: string
  role: UserRole
}

export interface DemoAccount extends Session {
  description: string // 로그인 화면에 표시할 역할 설명 한 줄
}

// 실제 백엔드 연동 시 세션은 서버가 발급하며, 프런트의 역할 검사는 편의이지 보안 경계가 아니다.
// 권한 판정의 최종 책임은 서버에 있다.

export interface Detection {
  id: string
  type: DetectionType
  label: string      // 화면 표시용 한글 라벨 예: '주민등록번호'
  start: number      // 원문 문자 오프셋, inclusive
  end: number        // exclusive
  masked: string     // 치환 토큰 예: '[이름1]'
  confidence: number // 0~1
}

export interface InspectionResult {
  requestId: string
  grade: Grade
  route: Route
  detections: Detection[]
  originalText: string
  maskedText: string
  reason: string     // 위험 등급 사유 한 줄. 그 외 등급은 빈 문자열
  elapsedMs: number
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' // 대화 발화자 역할이며 계정 권한인 UserRole과는 별개다.
  text: string
  route?: Route          // assistant 메시지가 어느 경로로 처리됐는지
  inspection?: InspectionResult  // user 메시지에 붙은 검사 결과
}

export interface AuditLogEntry {
  id: string
  at: string            // ISO 8601
  userName: string
  department: string
  grade: Grade
  route: Route
  detectionCounts: { label: string; count: number }[] // 유형별 건수만
  approvedBy?: string
}
// ★ AuditLogEntry 에 원문·탐지 값 필드를 추가하지 마라.
//   감사 로그 화면이 새 유출 경로가 되면 안 된다는 것이 이 프로젝트의 설계 원칙이다.

export interface AuditLogFilter {
  grade?: Grade | 'all'
  from?: string
  to?: string
  search?: string
}

export type ApprovalDecision = 'approved' | 'conditional' | 'rejected'
export type ApprovalState = 'pending' | 'approved' | 'conditional' | 'rejected'

export interface ApprovalRequestResult {
  approvalId: string
  status: 'pending'
}

export interface ApprovalDecisionResult {
  id: string
  decision: ApprovalDecision
  status: 'decided'
}

export interface ApprovalStatus {
  approvalId: string
  requestId: string
  state: ApprovalState
  requestedAt: string          // ISO 8601
  decidedAt?: string           // 결정된 경우만
  decidedBy?: string           // 결정한 관리자 이름
  rejectionReason?: string     // state === 'rejected' 일 때만
  consumedAt?: string          // 이 승인으로 전송이 이뤄진 시각
}
// ★ 승인은 1회용 허가다. 한 번 전송에 쓰인 승인(consumedAt 이 있는 승인)으로는
//   같은 요청을 다시 전송할 수 없다. 백엔드도 같은 규칙을 지켜야 한다.
// ★ ApprovalStatus 에 원문·탐지 값을 추가하지 마라.
//   승인 상태 조회가 새 유출 경로가 되지 않도록 식별자와 처리 결과만 전달한다.

export interface PendingApproval {
  id: string
  requestId: string
  at: string
  userName: string
  department: string
  reason: string
  detectionSummary: { label: string; count: number }[]
  maskedPreview: string  // 마스킹된 상태의 미리보기만
}

export interface DashboardSummary {
  byGrade: Record<Grade, number>
  blockedTrend: { date: string; count: number }[]   // 최근 14일
  byDetectionType: { label: string; count: number }[]
  pendingCount: number
  falsePositiveReports: number
}

/* ── 기업 사전 ─────────────────────────────────────────── */

export type DictionaryEntryType = 'partner' | 'product_code' | 'price_expression' | 'other'
export type DictionaryGrade = Extract<Grade, 'caution' | 'confidential'>

export interface DictionaryEntry {
  id: string
  term: string                 // 앞뒤 공백만 제거한 원본. 내부 공백은 보존한다
  entryType: DictionaryEntryType
  grade: DictionaryGrade
  active: boolean
  note: string                 // 왜 등록했는지 한 줄. 검사에 쓰이지 않는다
  updatedAt: string            // ISO 8601
  updatedBy: string            // 마지막으로 고친 관리자 이름
}
// ★ DictionaryEntry 에 사람 이름·연락처·고유식별정보를 넣지 마라.
//   사전 화면의 표가 개인정보 파일이 되면 관리 화면이 새 유출 경로가 된다.
//   이름 탐지는 별도 탐지 규칙이 담당한다.

/** 화면이 들고 있는 편집 중 행. 저장 전에는 서버 id가 없을 수 있다. */
export interface DictionaryDraftEntry {
  rowId: string                // 화면이 부여하는 행 식별자. 검증 결과를 행에 되돌리기 위한 것이다
  id?: string                  // 없으면 신규 항목
  term: string
  entryType: DictionaryEntryType
  grade: DictionaryGrade
  active: boolean
  note: string
}

export interface DictionarySnapshot {
  revision: number             // 저장할 때마다 1 증가한다
  updatedAt: string            // ISO 8601
  entries: DictionaryEntry[]
  activeLimit: number
}

export type DictionaryIssueLevel = 'error' | 'warning'
export type DictionaryIssueCode =
  | 'term_empty' | 'term_too_short' | 'term_short_warning' | 'term_too_long'
  | 'term_numeric_only' | 'term_duplicate' | 'term_inactive_exists'
  | 'note_too_long' | 'active_limit'

export interface DictionaryIssue {
  rowId: string                // 'total' 이면 표 전체에 대한 지적이다
  field: 'term' | 'note' | 'total'
  level: DictionaryIssueLevel
  code: DictionaryIssueCode
  message: string              // 화면에 그대로 보여 줄 한 줄
}

/** 정상 업무 문장에 초안 사전이 걸린 경우. 오탐 예고다. */
export interface FalsePositiveHit {
  sentence: string
  rowId: string
  label: string
  matched: string
}

export interface DictionaryDraftCheck {
  issues: DictionaryIssue[]
  falsePositiveHits: FalsePositiveHit[]
  activeCount: number
  activeLimit: number
}

export interface PreviewDelta {
  kind: 'added' | 'removed' | 'relabeled'
  label: string
  previousLabel?: string       // relabeled 일 때만
  matched: string
  start: number                // 원문 문자 오프셋, inclusive
  end: number                  // exclusive
}

export interface DictionaryPreview {
  saved: InspectionResult      // 저장된 사전으로 검사한 결과
  draft: InspectionResult      // 편집 중 초안으로 검사한 결과
  deltas: PreviewDelta[]
  gradeChanged: boolean
}
// ★ DictionaryPreview 의 두 결과는 inspections 저장소에 넣지 않는다.
//   requestId 가 preview- 로 시작하며 send() 로 전송할 수 없다.
//   시험 검사 입력은 사용자가 방금 타이핑한 원문이므로 저장하지도, 감사 로그에 남기지도 않는다.

export interface GradePolicyRow {
  grade: Grade
  route: Route
  employeeAction: string       // 직원 화면에서 실제로 일어나는 일 한 줄
}

/* ── 사용자·권한 ───────────────────────────────────────── */

export interface ManagedUser {
  userId: string
  name: string
  department: string
  role: UserRole
  lastActiveAt?: string        // ISO 8601. 감사 로그에 처리 기록이 없으면 없다
  isCurrentUser: boolean       // 본인 행 표시와 자기 편집 차단에 쓴다
}

export interface UserDirectory {
  users: ManagedUser[]                  // 승인자 → 감사자 → 직원, 같은 역할 안에서는 이름 가나다순
  roleCounts: Record<UserRole, number>
  pendingApprovalCount: number          // 마지막 승인자 차단 문구의 근거 수치
  canAssign: boolean                    // 현재 세션이 역할을 바꿀 수 있는가
}

export interface RoleChangeEntry {
  id: string
  at: string                   // ISO 8601
  actorName: string            // 바꾼 사람
  targetName: string           // 바뀐 사람
  from: UserRole
  to: UserRole
}
// ★ RoleChangeEntry 에 프롬프트 원문·탐지 값을 추가하지 마라.
//   이 기록은 계정 상태의 변화만 남긴다.
