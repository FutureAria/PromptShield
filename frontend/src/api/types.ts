export type Grade = 'normal' | 'caution' | 'confidential' | 'blocked'
export type Route = 'external_llm' | 'internal_llm' | 'masked_external' | 'blocked'
export type DetectionType =
  | 'rrn' | 'phone' | 'email' | 'account'
  | 'partner' | 'price' | 'source_code' | 'api_key'

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
  role: 'user' | 'assistant'
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

export interface PendingApproval {
  id: string
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
