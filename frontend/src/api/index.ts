export * from './types'
export * from './permissions'
export * from './roleAssignment'
export {
  DICTIONARY_ACTIVE_LIMIT,
  DICTIONARY_PASTE_ROW_LIMIT,
  dictionaryPresets,
  parseDictionaryPaste,
} from './dictionary'
export {
  DictionaryValidationError,
  assignRole,
  checkDictionaryDraft,
  decideApproval,
  getApprovalStatus,
  getAuditLogs,
  getDashboard,
  getDictionary,
  getGradePolicy,
  getPendingApprovals,
  getStoredSession,
  inspect,
  listDemoAccounts,
  listRoleChanges,
  listUsers,
  login,
  logout,
  previewInspection,
  reportFalsePositive,
  requestApproval,
  resetMockDelayRange,
  resetMockDictionary,
  resetMockUsers,
  saveDictionary,
  send,
  setMockDelayRange,
} from './mock'

// 실제 백엔드 연결 시 이 파일의 공개 API는 유지하고 위 mock export를
// fetch 기반 구현 모듈(예: './client')의 동일한 함수 export로 교체한다.
