import type {
  ApprovalDecision,
  ApprovalDecisionResult,
  ApprovalRequestResult,
  ApprovalState,
  ApprovalStatus,
  AuditLogFilter,
  AuditLogEntry,
  ChatMessage,
  DashboardSummary,
  DemoAccount,
  Detection,
  DetectionType,
  Grade,
  InspectionResult,
  PendingApproval,
  Route,
  Session,
} from './types'

interface DelayRange {
  min: number
  max: number
}

interface DetectionCandidate {
  type: DetectionType
  label: string
  start: number
  end: number
  tokenLabel: string
  confidence: number
  severity: Exclude<Grade, 'normal'>
  priority: number
}

const DEFAULT_DELAY: DelayRange = { min: 200, max: 700 }
const DEFAULT_INTERNAL_DELAY: DelayRange = { min: 1100, max: 1300 }
const DEFAULT_APPROVAL_STATUS_DELAY: DelayRange = { min: 60, max: 120 }
const SESSION_STORAGE_KEY = 'promptshield.session'

const demoAccounts: readonly DemoAccount[] = [
  {
    userId: 'emp-hong',
    name: '홍길동',
    department: '영업팀',
    role: 'employee',
    description: '업무 요청을 보내는 일반 직원',
  },
  {
    userId: 'emp-kim',
    name: '김철수',
    department: '생산관리팀',
    role: 'employee',
    description: '업무 요청을 보내는 일반 직원',
  },
  {
    userId: 'sec-park',
    name: '박보안',
    department: '정보보안팀',
    role: 'approver',
    description: '위험 요청의 승인·반려를 처리한다',
  },
  {
    userId: 'aud-lee',
    name: '이감사',
    department: '감사팀',
    role: 'auditor',
    description: '감사 로그를 조회한다. 승인 처리는 할 수 없다',
  },
]

let standardDelay: DelayRange = { ...DEFAULT_DELAY }
let internalDelay: DelayRange = { ...DEFAULT_INTERNAL_DELAY }
let approvalStatusDelay: DelayRange = { ...DEFAULT_APPROVAL_STATUS_DELAY }
let sequence = 0

const inspections = new Map<string, InspectionResult>()
const approvalStatuses = new Map<string, ApprovalStatus>()
const falsePositiveReportKeys = new Set<string>()

function isSession(value: unknown): value is Session {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const session = value as Record<string, unknown>
  return typeof session.userId === 'string'
    && typeof session.name === 'string'
    && typeof session.department === 'string'
    && (session.role === 'employee' || session.role === 'approver' || session.role === 'auditor')
}

export async function listDemoAccounts(): Promise<DemoAccount[]> {
  return demoAccounts.map((account) => ({ ...account }))
}

export async function login(userId: string): Promise<Session> {
  const account = demoAccounts.find((candidate) => candidate.userId === userId)
  if (!account) {
    throw new Error('데모 계정을 찾을 수 없다.')
  }

  const session: Session = {
    userId: account.userId,
    name: account.name,
    department: account.department,
    role: account.role,
  }

  try {
    globalThis.sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session))
  } catch {
    // 저장소를 사용할 수 없는 환경에서도 현재 로그인 시도 자체는 완료한다.
  }

  return session
}

export async function logout(): Promise<void> {
  try {
    globalThis.sessionStorage.removeItem(SESSION_STORAGE_KEY)
  } catch {
    // 저장소 접근이 차단된 환경에서는 지울 세션도 지속되지 않는다.
  }
}

export function getStoredSession(): Session | null {
  try {
    const stored = globalThis.sessionStorage.getItem(SESSION_STORAGE_KEY)
    if (!stored) {
      return null
    }

    const session: unknown = JSON.parse(stored)
    return isSession(session) ? session : null
  } catch {
    return null
  }
}

function requireAdminAccess(): void {
  if (getStoredSession()?.role === 'employee') {
    throw new Error('관리자 권한이 없다.')
  }
}

const routeByGrade: Record<Grade, Route> = {
  normal: 'external_llm',
  caution: 'masked_external',
  confidential: 'internal_llm',
  blocked: 'blocked',
}

const gradeWeight: Record<Grade, number> = {
  normal: 0,
  caution: 1,
  confidential: 2,
  blocked: 3,
}

const stateByDecision: Record<ApprovalDecision, Exclude<ApprovalState, 'pending'>> = {
  approved: 'approved',
  conditional: 'conditional',
  rejected: 'rejected',
}

function createId(prefix: string): string {
  sequence += 1
  return `${prefix}-${Date.now().toString(36)}-${sequence.toString(36).padStart(3, '0')}`
}

function validateDelayRange(min: number, max: number): void {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max < min) {
    throw new RangeError('목 API 지연은 0 이상이며 최솟값이 최댓값보다 클 수 없다.')
  }
}

/** 테스트에서는 setMockDelayRange(0, 0)으로 모든 인위적 지연을 없앨 수 있다. */
export function setMockDelayRange(min: number, max: number): void {
  validateDelayRange(min, max)
  standardDelay = { min, max }

  if (min === 0 && max === 0) {
    internalDelay = { min: 0, max: 0 }
    approvalStatusDelay = { min: 0, max: 0 }
    return
  }

  // 사용자 지정 지연에서도 사내 LLM은 일반 요청보다 약 두 배 오래 걸리게 유지한다.
  internalDelay = { min: min * 2, max: max * 2 }
  approvalStatusDelay = {
    min: Math.floor(min / 4),
    max: Math.floor(max / 4),
  }
}

export function resetMockDelayRange(): void {
  standardDelay = { ...DEFAULT_DELAY }
  internalDelay = { ...DEFAULT_INTERNAL_DELAY }
  approvalStatusDelay = { ...DEFAULT_APPROVAL_STATUS_DELAY }
}

async function waitForMock(range: DelayRange): Promise<number> {
  const duration = range.min === range.max
    ? range.min
    : Math.floor(Math.random() * (range.max - range.min + 1)) + range.min

  if (duration > 0) {
    await new Promise<void>((resolve) => {
      globalThis.setTimeout(resolve, duration)
    })
  }

  return duration
}

function addRegexMatches(
  text: string,
  candidates: DetectionCandidate[],
  regex: RegExp,
  candidate: Omit<DetectionCandidate, 'start' | 'end'>,
): void {
  for (const match of text.matchAll(regex)) {
    const matchedText = match[0]
    const start = match.index
    if (start === undefined || matchedText.length === 0) {
      continue
    }

    candidates.push({
      ...candidate,
      start,
      end: start + matchedText.length,
    })
  }
}

function addLiteralMatches(
  text: string,
  candidates: DetectionCandidate[],
  literals: readonly string[],
  candidate: Omit<DetectionCandidate, 'start' | 'end'>,
): void {
  for (const literal of literals) {
    let fromIndex = 0
    while (fromIndex < text.length) {
      const start = text.indexOf(literal, fromIndex)
      if (start === -1) {
        break
      }

      candidates.push({
        ...candidate,
        start,
        end: start + literal.length,
      })
      fromIndex = start + literal.length
    }
  }
}

function rangesOverlap(first: DetectionCandidate, second: DetectionCandidate): boolean {
  return first.start < second.end && second.start < first.end
}

function findCandidates(text: string): DetectionCandidate[] {
  const candidates: DetectionCandidate[] = []

  addRegexMatches(text, candidates, /\d{6}-\d{7}/g, {
    type: 'rrn',
    label: '주민등록번호',
    tokenLabel: '주민번호',
    confidence: 0.99,
    severity: 'blocked',
    priority: 0,
  })
  addRegexMatches(text, candidates, /(sk|api|token)[-_][A-Za-z0-9]{8,}/gi, {
    type: 'api_key',
    label: 'API 키',
    tokenLabel: '키',
    confidence: 0.98,
    severity: 'blocked',
    priority: 1,
  })
  addRegexMatches(text, candidates, /function |class |SELECT |import |=>/g, {
    type: 'source_code',
    label: '소스 코드',
    tokenLabel: '코드',
    confidence: 0.9,
    severity: 'confidential',
    priority: 2,
  })
  addLiteralMatches(text, candidates, ['ABC상사', '대한물산', '한빛테크'], {
    type: 'partner',
    label: '거래처',
    tokenLabel: '거래처',
    confidence: 0.96,
    severity: 'confidential',
    priority: 3,
  })
  addRegexMatches(text, candidates, /단가\s*[\d,]+\s*원/g, {
    type: 'price',
    label: '단가',
    tokenLabel: '단가',
    confidence: 0.95,
    severity: 'confidential',
    priority: 4,
  })
  // 전화번호도 계좌번호 형태와 일치할 수 있어 더 구체적인 전화 규칙을 먼저 적용한다.
  addRegexMatches(text, candidates, /01[016-9]-?\d{3,4}-?\d{4}/g, {
    type: 'phone',
    label: '전화번호',
    tokenLabel: '전화',
    confidence: 0.98,
    severity: 'caution',
    priority: 5,
  })
  addRegexMatches(text, candidates, /\d{3}-\d{2,6}-\d{2,6}/g, {
    type: 'account',
    label: '계좌번호',
    tokenLabel: '계좌',
    confidence: 0.92,
    severity: 'caution',
    priority: 6,
  })
  addRegexMatches(text, candidates, /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, {
    type: 'email',
    label: '이메일',
    tokenLabel: '이메일',
    confidence: 0.98,
    severity: 'caution',
    priority: 7,
  })
  // 공통 계약에 name 유형이 없으므로 사전 기반 고유명사인 partner 유형으로 전달한다.
  // 화면과 집계는 label/tokenLabel을 사용하므로 이름 표기와 주의 등급은 그대로 유지된다.
  addLiteralMatches(text, candidates, ['홍길동', '김철수', '이영희'], {
    type: 'partner',
    label: '이름',
    tokenLabel: '이름',
    confidence: 0.96,
    severity: 'caution',
    priority: 8,
  })

  // 겹치는 구간은 하나만 살아남으므로 심각도가 높은 후보를 먼저 채택해야 한다.
  // start 순으로 채택하면 앞서 시작한 낮은 등급이 뒤에 오는 높은 등급을 덮어,
  // 등급이 내려가고 원문 일부가 마스킹되지 않은 채 외부로 나간다.
  const ordered = candidates.sort((first, second) => (
    gradeWeight[second.severity] - gradeWeight[first.severity]
    || first.priority - second.priority
    || first.start - second.start
    || second.end - first.end
  ))
  const accepted: DetectionCandidate[] = []

  for (const candidate of ordered) {
    if (!accepted.some((existing) => rangesOverlap(existing, candidate))) {
      accepted.push(candidate)
    }
  }

  // 채택은 심각도 순으로 했으므로 토큰 번호와 목록 순서를 위해 다시 본문 순서로 되돌린다.
  return accepted.sort((first, second) => first.start - second.start)
}

function createDetections(
  requestId: string,
  candidates: DetectionCandidate[],
): Detection[] {
  const tokenCounts = new Map<string, number>()

  return candidates.map((candidate, index) => {
    const tokenCount = (tokenCounts.get(candidate.tokenLabel) ?? 0) + 1
    tokenCounts.set(candidate.tokenLabel, tokenCount)

    return {
      id: `${requestId}-d${index + 1}`,
      type: candidate.type,
      label: candidate.label,
      start: candidate.start,
      end: candidate.end,
      masked: `[${candidate.tokenLabel}${tokenCount}]`,
      confidence: candidate.confidence,
    }
  })
}

function maskText(text: string, detections: Detection[]): string {
  return [...detections]
    .sort((first, second) => second.start - first.start)
    .reduce((masked, detection) => (
      `${masked.slice(0, detection.start)}${detection.masked}${masked.slice(detection.end)}`
    ), text)
}

function gradeCandidates(candidates: DetectionCandidate[]): Grade {
  return candidates.reduce<Grade>((current, candidate) => (
    gradeWeight[candidate.severity] > gradeWeight[current]
      ? candidate.severity
      : current
  ), 'normal')
}

export async function inspect(text: string): Promise<InspectionResult> {
  const requestId = createId('req')
  const candidates = findCandidates(text)
  const detections = createDetections(requestId, candidates)
  const grade = gradeCandidates(candidates)
  const elapsedMs = await waitForMock(standardDelay)

  const result: InspectionResult = {
    requestId,
    grade,
    route: routeByGrade[grade],
    detections,
    originalText: text,
    maskedText: maskText(text, detections),
    reason: grade === 'blocked'
      ? '고유식별정보 또는 비밀 키가 포함되어 전송을 차단했다. 해당 구간을 지우고 다시 검사하거나 관리자 승인을 요청한다.'
      : '',
    elapsedMs,
  }

  inspections.set(requestId, result)
  return result
}

function responseForGrade(grade: Grade): string {
  switch (grade) {
    case 'normal':
      return '요청한 내용을 확인했다. 핵심 항목을 기준으로 간결하게 정리해 활용할 수 있다.'
    case 'caution':
      return '민감정보를 마스킹한 전송본으로 처리했다. 원문 값은 외부 LLM에 전달하지 않았다.'
    case 'confidential':
      return '사내 LLM에서 처리했다. 이 요청은 외부로 전송되지 않았다. 내부 자료의 맥락을 유지해 답변을 준비했다.'
    case 'blocked':
      return '전송이 차단된 요청이다.'
  }
}

export async function send(requestId: string): Promise<ChatMessage> {
  const inspection = inspections.get(requestId)
  if (!inspection) {
    throw new Error('검사 결과를 찾을 수 없다. 내용을 다시 검사해 달라.')
  }

  let route = inspection.route
  let responseText = responseForGrade(inspection.grade)

  if (inspection.grade === 'blocked') {
    const approvalStatus = approvalStatuses.get(requestId)
    if (!approvalStatus || approvalStatus.state === 'pending') {
      throw new Error('관리자 승인 전에는 전송할 수 없다.')
    }
    if (approvalStatus.state === 'rejected') {
      throw new Error('관리자가 반려한 요청이다.')
    }
    if (approvalStatus.consumedAt) {
      throw new Error('이미 전송에 사용한 승인이다. 내용을 다시 검사해 승인을 요청해 달라.')
    }

    // 승인은 1회용이므로 전송을 기다리기 전에 소모 처리한다.
    // 지연 뒤에 기록하면 연속 호출이 둘 다 검사를 통과해 중복 전송된다.
    approvalStatuses.set(requestId, {
      ...approvalStatus,
      consumedAt: new Date().toISOString(),
    })

    if (approvalStatus.state === 'approved') {
      route = 'external_llm'
      responseText = '관리자 승인에 따라 원문을 외부 LLM으로 전송해 처리했다.'
    } else {
      route = 'masked_external'
      responseText = '관리자의 조건부 승인에 따라 민감정보를 마스킹한 전송본으로 처리했다. 원문 값은 외부 LLM에 전달하지 않았다.'
    }
  }

  await waitForMock(
    route === 'internal_llm' ? internalDelay : standardDelay,
  )

  return {
    id: createId('message'),
    role: 'assistant',
    text: responseText,
    route,
  }
}

function summarizeDetections(detections: Detection[]): { label: string; count: number }[] {
  const counts = new Map<string, number>()
  for (const detection of detections) {
    counts.set(detection.label, (counts.get(detection.label) ?? 0) + 1)
  }

  return [...counts].map(([label, count]) => ({ label, count }))
}

export async function requestApproval(requestId: string): Promise<ApprovalRequestResult> {
  // 목 지연 중 로그아웃하거나 계정을 바꿔도 요청을 시작한 사용자의 귀속을 유지한다.
  const session = getStoredSession()
  await waitForMock(standardDelay)
  const inspection = inspections.get(requestId)
  if (!inspection) {
    throw new Error('검사 결과를 찾을 수 없다. 내용을 다시 검사해 달라.')
  }
  if (inspection.grade !== 'blocked') {
    throw new Error('관리자 승인은 위험 등급 요청에서만 요청할 수 있다.')
  }

  const existingStatus = approvalStatuses.get(requestId)
  if (existingStatus?.state === 'pending') {
    return { approvalId: existingStatus.approvalId, status: 'pending' }
  }
  if (existingStatus) {
    throw new Error('이미 처리된 승인 요청이다. 내용을 수정한 후 다시 검사해 달라.')
  }

  const requestedAt = new Date().toISOString()
  const approval: PendingApproval = {
    id: createId('approval'),
    requestId,
    at: requestedAt,
    userName: session?.name ?? '홍길동',
    department: session?.department ?? '영업팀',
    reason: inspection.reason || '정책상 관리자 확인이 필요한 요청이다.',
    detectionSummary: summarizeDetections(inspection.detections),
    maskedPreview: inspection.maskedText,
  }
  pendingApprovals.unshift(approval)
  approvalStatuses.set(requestId, {
    approvalId: approval.id,
    requestId,
    state: 'pending',
    requestedAt,
  })

  return { approvalId: approval.id, status: 'pending' }
}

export async function getApprovalStatus(requestId: string): Promise<ApprovalStatus | null> {
  await waitForMock(approvalStatusDelay)
  const status = approvalStatuses.get(requestId)
  return status ? { ...status } : null
}

export async function reportFalsePositive(
  requestId: string,
  detectionId: string,
): Promise<{ reported: true }> {
  await waitForMock(standardDelay)
  const inspection = inspections.get(requestId)
  const detectionExists = inspection?.detections.some(({ id }) => id === detectionId) ?? false

  if (!inspection || !detectionExists) {
    throw new Error('신고할 탐지 항목을 찾을 수 없다.')
  }

  falsePositiveReportKeys.add(`${requestId}:${detectionId}`)
  return { reported: true }
}

function isoDaysAgo(daysAgo: number, hour = 9): string {
  const date = new Date()
  date.setUTCHours(hour, 0, 0, 0)
  date.setUTCDate(date.getUTCDate() - daysAgo)
  return date.toISOString()
}

function detectionCountsForGrade(
  grade: Grade,
  index: number,
): { label: string; count: number }[] {
  switch (grade) {
    case 'normal':
      return []
    case 'caution': {
      const cautionLabels = ['이름', '전화번호', '이메일', '계좌번호'] as const
      const firstLabel = cautionLabels[index % cautionLabels.length] ?? '이름'
      const secondLabel = cautionLabels[(index + 2) % cautionLabels.length] ?? '이메일'
      return index % 3 === 0
        ? [{ label: firstLabel, count: 1 }, { label: secondLabel, count: 1 }]
        : [{ label: firstLabel, count: (index % 2) + 1 }]
    }
    case 'confidential': {
      const labels = ['거래처', '단가', '소스 코드'] as const
      return [{ label: labels[index % labels.length] ?? '거래처', count: (index % 2) + 1 }]
    }
    case 'blocked':
      return [{ label: index % 2 === 0 ? '주민등록번호' : 'API 키', count: 1 }]
  }
}

function makeAuditLogs(): AuditLogEntry[] {
  const users = ['홍길동', '김철수', '이영희'] as const
  const departments = ['영업팀', '생산관리팀', '개발팀', '경영지원팀', '품질관리팀'] as const
  const grades: readonly Grade[] = [
    'normal',
    'caution',
    'normal',
    'confidential',
    'caution',
    'blocked',
    'normal',
    'caution',
  ]

  return Array.from({ length: 52 }, (_, index): AuditLogEntry => {
    const grade = grades[index % grades.length] ?? 'normal'
    const entry: AuditLogEntry = {
      id: `REQ-${String(index + 1).padStart(4, '0')}`,
      at: isoDaysAgo(index % 14, 7 + (index % 10)),
      userName: users[index % users.length] ?? '홍길동',
      department: departments[(index * 2) % departments.length] ?? '영업팀',
      grade,
      route: routeByGrade[grade],
      detectionCounts: detectionCountsForGrade(grade, index),
    }

    if (grade === 'blocked' && index % 3 === 0) {
      entry.approvedBy = '보안 관리자'
    }
    return entry
  }).sort((first, second) => second.at.localeCompare(first.at))
}

const auditLogs = makeAuditLogs()
const initialPendingApprovals: readonly PendingApproval[] = [
  {
    id: 'approval-001',
    requestId: 'req-approval-sample-001',
    at: isoDaysAgo(0, 8),
    userName: '김철수',
    department: '생산관리팀',
    reason: '고유식별정보 형식이 포함되어 관리자 확인이 필요하다.',
    detectionSummary: [{ label: '주민등록번호', count: 1 }],
    maskedPreview: '입사 서류의 [주민번호1] 확인 절차를 안내해 줘.',
  },
  {
    id: 'approval-002',
    requestId: 'req-approval-sample-002',
    at: isoDaysAgo(0, 7),
    userName: '이영희',
    department: '개발팀',
    reason: '비밀 키 형식이 포함되어 외부 전송이 차단되었다.',
    detectionSummary: [{ label: 'API 키', count: 1 }],
    maskedPreview: '테스트 환경의 [키1] 교체 절차를 정리해 줘.',
  },
  {
    id: 'approval-003',
    requestId: 'req-approval-sample-003',
    at: isoDaysAgo(1, 15),
    userName: '홍길동',
    department: '영업팀',
    reason: '고유식별정보가 포함되어 전송 전에 승인이 필요하다.',
    detectionSummary: [{ label: '주민등록번호', count: 1 }, { label: '이름', count: 1 }],
    maskedPreview: '[이름1] 고객의 [주민번호1] 관련 문의 답변을 작성해 줘.',
  },
  {
    id: 'approval-004',
    requestId: 'req-approval-sample-004',
    at: isoDaysAgo(2, 11),
    userName: '김철수',
    department: '경영지원팀',
    reason: '비밀 키가 포함되어 관리자 확인 없이 전송할 수 없다.',
    detectionSummary: [{ label: 'API 키', count: 1 }],
    maskedPreview: '[키1] 사용 중단 공지를 작성해 줘.',
  },
]

let pendingApprovals: PendingApproval[] = initialPendingApprovals.map((approval) => ({
  ...approval,
  detectionSummary: approval.detectionSummary.map((item) => ({ ...item })),
}))

for (const approval of pendingApprovals) {
  approvalStatuses.set(approval.requestId, {
    approvalId: approval.id,
    requestId: approval.requestId,
    state: 'pending',
    requestedAt: approval.at,
  })
}

function utcDateKey(daysAgo: number): string {
  const date = new Date()
  date.setUTCHours(0, 0, 0, 0)
  date.setUTCDate(date.getUTCDate() - daysAgo)
  return date.toISOString().slice(0, 10)
}

export async function getDashboard(): Promise<DashboardSummary> {
  requireAdminAccess()
  await waitForMock(standardDelay)

  const byGrade: Record<Grade, number> = {
    normal: 0,
    caution: 0,
    confidential: 0,
    blocked: 0,
  }
  const detectionCounts = new Map<string, number>()

  for (const entry of auditLogs) {
    byGrade[entry.grade] += 1
    for (const detection of entry.detectionCounts) {
      detectionCounts.set(
        detection.label,
        (detectionCounts.get(detection.label) ?? 0) + detection.count,
      )
    }
  }

  const blockedByDate = new Map<string, number>()
  for (const entry of auditLogs) {
    if (entry.grade === 'blocked') {
      const date = entry.at.slice(0, 10)
      blockedByDate.set(date, (blockedByDate.get(date) ?? 0) + 1)
    }
  }

  return {
    byGrade,
    blockedTrend: Array.from({ length: 14 }, (_, index) => {
      const date = utcDateKey(13 - index)
      return { date, count: blockedByDate.get(date) ?? 0 }
    }),
    byDetectionType: [...detectionCounts]
      .map(([label, count]) => ({ label, count }))
      .sort((first, second) => second.count - first.count || first.label.localeCompare(second.label, 'ko')),
    pendingCount: pendingApprovals.length,
    falsePositiveReports: 7 + falsePositiveReportKeys.size,
  }
}

function normalizeFrom(value: string): number | null {
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? `${value}T00:00:00.000Z`
    : value
  const timestamp = Date.parse(normalized)
  return Number.isNaN(timestamp) ? null : timestamp
}

function normalizeTo(value: string): number | null {
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? `${value}T23:59:59.999Z`
    : value
  const timestamp = Date.parse(normalized)
  return Number.isNaN(timestamp) ? null : timestamp
}

export async function getAuditLogs(filter: AuditLogFilter = {}): Promise<AuditLogEntry[]> {
  requireAdminAccess()
  await waitForMock(standardDelay)
  const from = filter.from ? normalizeFrom(filter.from) : null
  const to = filter.to ? normalizeTo(filter.to) : null
  const search = filter.search?.trim().toLocaleLowerCase('ko') ?? ''

  return auditLogs
    .filter((entry) => {
      if (filter.grade && filter.grade !== 'all' && entry.grade !== filter.grade) {
        return false
      }

      const at = Date.parse(entry.at)
      if (from !== null && at < from) {
        return false
      }
      if (to !== null && at > to) {
        return false
      }

      if (search) {
        const searchable = [
          entry.id,
          entry.userName,
          entry.department,
          entry.route,
          entry.approvedBy ?? '',
          ...entry.detectionCounts.map(({ label }) => label),
        ].join(' ').toLocaleLowerCase('ko')
        if (!searchable.includes(search)) {
          return false
        }
      }

      return true
    })
    .map((entry) => ({
      ...entry,
      detectionCounts: entry.detectionCounts.map((item) => ({ ...item })),
    }))
    .sort((first, second) => second.at.localeCompare(first.at))
}

export async function getPendingApprovals(): Promise<PendingApproval[]> {
  requireAdminAccess()
  await waitForMock(standardDelay)
  return pendingApprovals.map((approval) => ({
    ...approval,
    detectionSummary: approval.detectionSummary.map((item) => ({ ...item })),
  }))
}

export async function decideApproval(
  id: string,
  decision: ApprovalDecision,
  reason?: string,
): Promise<ApprovalDecisionResult> {
  const session = getStoredSession()
  if (session && session.role !== 'approver') {
    throw new Error('승인 처리 권한이 없다.')
  }

  await waitForMock(standardDelay)
  const index = pendingApprovals.findIndex((approval) => approval.id === id)
  const approval = pendingApprovals[index]

  if (index < 0 || !approval) {
    throw new Error('이미 처리되었거나 찾을 수 없는 승인 요청이다.')
  }
  if (decision === 'rejected' && !reason?.trim()) {
    throw new Error('반려하는 이유를 입력해 달라.')
  }

  pendingApprovals.splice(index, 1)
  const decidedAt = new Date().toISOString()
  const decidedBy = session?.name ?? '보안 관리자'
  const currentStatus = approvalStatuses.get(approval.requestId)
  approvalStatuses.set(approval.requestId, {
    approvalId: approval.id,
    requestId: approval.requestId,
    state: stateByDecision[decision],
    requestedAt: currentStatus?.requestedAt ?? approval.at,
    decidedAt,
    decidedBy,
    ...(decision === 'rejected' ? { rejectionReason: reason } : {}),
  })

  const auditEntry: AuditLogEntry = {
    id: createId('REQ'),
    at: decidedAt,
    userName: approval.userName,
    department: approval.department,
    grade: 'blocked',
    route: decision === 'approved'
      ? 'external_llm'
      : decision === 'conditional'
        ? 'masked_external'
        : 'blocked',
    detectionCounts: approval.detectionSummary.map((item) => ({ ...item })),
    approvedBy: decidedBy,
  }
  auditLogs.unshift(auditEntry)

  return { id, decision, status: 'decided' }
}
