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
