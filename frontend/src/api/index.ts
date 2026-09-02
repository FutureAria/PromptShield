export * from './types'
export {
  decideApproval,
  getAuditLogs,
  getDashboard,
  getPendingApprovals,
  inspect,
  reportFalsePositive,
  requestApproval,
  resetMockDelayRange,
  send,
  setMockDelayRange,
} from './mock'
export type {
  ApprovalDecision,
  ApprovalDecisionResult,
  ApprovalRequestResult,
  AuditLogFilter,
} from './mock'

// 실제 백엔드 연결 시 이 파일의 공개 API는 유지하고 위 mock export를
// fetch 기반 구현 모듈(예: './client')의 동일한 함수 export로 교체한다.
