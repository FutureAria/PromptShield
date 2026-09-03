export * from './types'
export * from './attachments'
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
  clearActiveInspection,
  decideApproval,
  getActiveInspection,
  getApprovalStatus,
  getAuditLogs,
  getDashboard,
  getDictionary,
  getGradePolicy,
  getInspection,
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
  resetDemoState,
  resetMockDelayRange,
  resetMockDictionary,
  resetMockUsers,
  saveDictionary,
  send,
  setMockDelayRange,
} from './client'

// 공개 API 는 그대로 두고 구현만 './mock' 에서 './client' 로 바꿨다.
// client 는 기동할 때 /api/health 를 한 번 확인해, 백엔드가 있으면 실제 게이트웨이를
// 쓰고 없으면 목으로 떨어진다. 백엔드 없이도 화면 시연이 끊기지 않는다.
