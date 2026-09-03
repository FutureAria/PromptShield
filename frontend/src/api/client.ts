/**
 * 백엔드 연동 클라이언트.
 *
 * 백엔드가 떠 있으면 실제 게이트웨이(FastAPI)를 쓰고, 없으면 목 구현으로 떨어진다.
 * 판정은 기동할 때 `/api/health` 를 한 번 확인해 정한다. 덕분에 이미지 하나로
 * 백엔드 없는 발표(프런트만 기동)와 전체 구성 시연을 모두 할 수 있다.
 *
 * ★ 이 파일이 목의 규칙을 다시 구현하지 않는다. 등급 판정·마스킹·승인 수명주기는
 *   전부 서버가 정한다. 여기서는 옮기기만 한다.
 */

import * as mock from './mock'
import { DictionaryValidationError } from './mock'
import type {
  ApprovalDecision, ApprovalDecisionResult, ApprovalRequestResult, ApprovalStatus,
  AuditLogEntry, AuditLogFilter, ChatMessage, DashboardSummary, DemoAccount,
  DictionaryDraftCheck, DictionaryDraftEntry, DictionaryPreview, DictionarySnapshot,
  GradePolicyRow, InspectionResult, ManagedUser, PendingApproval, RoleChangeEntry,
  Session, UserDirectory, UserRole,
} from './types'

export { DictionaryValidationError }

const API_BASE = '/api'
const SESSION_STORAGE_KEY = 'promptshield.session'
const TOKEN_STORAGE_KEY = 'promptshield.token'
const HEALTH_TIMEOUT_MS = 800

/* ── 백엔드 유무 판정 ───────────────────────────────────────────────── */

/**
 * 판정은 모듈을 읽을 때 한 번 시작하고, 결과는 동기 플래그로 들고 있다.
 *
 * 매 호출마다 프로브를 기다리게 하면 백엔드가 없는 환경(테스트, 프런트만 기동한
 * 발표)에서 모든 호출이 타임아웃만큼 늦어진다. 그래서 대기는 로그인 화면에서만
 * 하고, 그 뒤의 호출은 이미 정해진 플래그를 읽는다. 로그인 전에 모드가 확정되므로
 * 세션은 목과 서버 중 한쪽에서만 만들어진다.
 */
let backendReady = false

const backendProbe: Promise<boolean> = (async () => {
  try {
    const controller = new AbortController()
    const timer = globalThis.setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS)
    const response = await fetch(`${API_BASE}/health`, { signal: controller.signal })
    globalThis.clearTimeout(timer)
    backendReady = response.ok
  } catch {
    // 백엔드가 없으면 목으로 시연한다. 화면이 죽지 않는 것이 우선이다.
    backendReady = false
  }
  return backendReady
})()

/** 로그인 화면에서만 쓴다. 여기서 모드를 확정한다. */
async function awaitBackend(): Promise<boolean> {
  return backendProbe
}

/** 그 밖의 모든 호출이 쓴다. 기다리지 않는다. */
function useBackend(): boolean {
  return backendReady
}

/* ── 저장소 ─────────────────────────────────────────────────────────── */

function readToken(): string | null {
  try {
    return globalThis.sessionStorage.getItem(TOKEN_STORAGE_KEY)
  } catch {
    return null
  }
}

function writeSession(session: Session | null, token: string | null): void {
  try {
    if (session && token) {
      globalThis.sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session))
      globalThis.sessionStorage.setItem(TOKEN_STORAGE_KEY, token)
    } else {
      globalThis.sessionStorage.removeItem(SESSION_STORAGE_KEY)
      globalThis.sessionStorage.removeItem(TOKEN_STORAGE_KEY)
    }
  } catch {
    // 저장소를 쓸 수 없는 환경에서도 호출 자체는 완료한다.
  }
}

/* ── 요청 ───────────────────────────────────────────────────────────── */

interface RequestOptions {
  method?: string
  body?: unknown
  /** 이 상태 코드면 예외 대신 null 을 돌려준다. */
  nullOn?: number[]
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const token = readToken()
  const response = await fetch(`${API_BASE}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  })

  if (options.nullOn?.includes(response.status)) {
    return null as T
  }

  if (!response.ok) {
    throw await toError(response)
  }

  if (response.status === 204) {
    return undefined as T
  }
  return await response.json() as T
}

async function toError(response: Response): Promise<Error> {
  let detail: unknown = null
  try {
    const body = await response.json() as { detail?: unknown }
    detail = body.detail
  } catch {
    detail = null
  }

  // 사전 저장 실패는 화면이 행마다 표시해야 하므로 전용 오류로 올린다.
  if (response.status === 422 && detail && typeof detail === 'object' && 'issues' in detail) {
    return new DictionaryValidationError((detail as { issues: [] }).issues)
  }
  if (typeof detail === 'string' && detail.length > 0) {
    return new Error(detail)
  }
  return new Error(`요청을 처리하지 못했다. (HTTP ${response.status})`)
}

/* ── 인증 ───────────────────────────────────────────────────────────── */

export async function listDemoAccounts(): Promise<DemoAccount[]> {
  if (!await awaitBackend()) return mock.listDemoAccounts()
  return request<DemoAccount[]>('/accounts')
}

export async function login(userId: string): Promise<Session> {
  if (!await awaitBackend()) return mock.login(userId)
  const body = await request<{ token: string; session: Session }>(
    '/auth/login', { method: 'POST', body: { userId } },
  )
  writeSession(body.session, body.token)
  return body.session
}

export async function logout(): Promise<void> {
  if (!useBackend()) return mock.logout()
  try {
    await request<{ ok: boolean }>('/auth/logout', { method: 'POST' })
  } finally {
    writeSession(null, null)
  }
}

/** 동기 함수다. 두 방식 모두 같은 저장소 키를 쓴다. */
export function getStoredSession(): Session | null {
  return mock.getStoredSession()
}

/* ── 검사 ───────────────────────────────────────────────────────────── */

export async function inspect(text: string): Promise<InspectionResult> {
  if (!useBackend()) return mock.inspect(text)
  return request<InspectionResult>('/inspect', { method: 'POST', body: { text } })
}

export async function getInspection(requestId: string): Promise<InspectionResult | null> {
  if (!useBackend()) return mock.getInspection(requestId)
  return request<InspectionResult | null>(
    `/inspections/${encodeURIComponent(requestId)}`, { nullOn: [403, 404] },
  )
}

export async function getActiveInspection(): Promise<InspectionResult | null> {
  if (!useBackend()) return mock.getActiveInspection()
  return request<InspectionResult | null>('/inspections/active', { nullOn: [401, 404] })
}

/** 동기 계약이라 결과를 기다리지 않는다. 서버 쪽 해제는 뒤따라 일어난다. */
export function clearActiveInspection(requestId: string): void {
  mock.clearActiveInspection(requestId)
  if (!useBackend()) return
  void request<{ ok: boolean }>(
    `/inspections/active/${encodeURIComponent(requestId)}`, { method: 'DELETE' },
  ).catch(() => undefined)
}

export async function send(requestId: string): Promise<ChatMessage> {
  if (!useBackend()) return mock.send(requestId)
  return request<ChatMessage>(
    `/inspections/${encodeURIComponent(requestId)}/send`, { method: 'POST' },
  )
}

export async function reportFalsePositive(
  requestId: string, detectionId: string,
): Promise<{ reported: true }> {
  if (!useBackend()) return mock.reportFalsePositive(requestId, detectionId)
  return request<{ reported: true }>(
    `/inspections/${encodeURIComponent(requestId)}/false-positive`,
    { method: 'POST', body: { detectionId } },
  )
}

/* ── 승인 ───────────────────────────────────────────────────────────── */

export async function requestApproval(requestId: string): Promise<ApprovalRequestResult> {
  if (!useBackend()) return mock.requestApproval(requestId)
  return request<ApprovalRequestResult>(
    `/inspections/${encodeURIComponent(requestId)}/approval`, { method: 'POST' },
  )
}

export async function getApprovalStatus(requestId: string): Promise<ApprovalStatus | null> {
  if (!useBackend()) return mock.getApprovalStatus(requestId)
  return request<ApprovalStatus | null>(
    `/inspections/${encodeURIComponent(requestId)}/approval`, { nullOn: [403, 404] },
  )
}

export async function getPendingApprovals(): Promise<PendingApproval[]> {
  if (!useBackend()) return mock.getPendingApprovals()
  return request<PendingApproval[]>('/approvals/pending')
}

export async function decideApproval(
  id: string, decision: ApprovalDecision, reason?: string,
): Promise<ApprovalDecisionResult> {
  if (!useBackend()) return mock.decideApproval(id, decision, reason)
  return request<ApprovalDecisionResult>(
    `/approvals/${encodeURIComponent(id)}/decision`,
    { method: 'POST', body: { decision, reason: reason ?? null } },
  )
}

/* ── 감사 로그 · 현황 ───────────────────────────────────────────────── */

export async function getAuditLogs(filter: AuditLogFilter = {}): Promise<AuditLogEntry[]> {
  if (!useBackend()) return mock.getAuditLogs(filter)
  const params = new URLSearchParams()
  if (filter.grade && filter.grade !== 'all') params.set('grade', filter.grade)
  if (filter.from) params.set('from', filter.from)
  if (filter.to) params.set('to', filter.to)
  if (filter.search) params.set('search', filter.search)
  const query = params.toString()
  return request<AuditLogEntry[]>(`/audit-logs${query ? `?${query}` : ''}`)
}

export async function getDashboard(): Promise<DashboardSummary> {
  if (!useBackend()) return mock.getDashboard()
  return request<DashboardSummary>('/dashboard')
}

/** 동기 계약이고 값이 고정이라 서버를 부르지 않는다. */
export function getGradePolicy(): GradePolicyRow[] {
  return mock.getGradePolicy()
}

/* ── 기업 사전 ──────────────────────────────────────────────────────── */

export async function getDictionary(): Promise<DictionarySnapshot> {
  if (!useBackend()) return mock.getDictionary()
  return request<DictionarySnapshot>('/dictionary')
}

export async function checkDictionaryDraft(
  draft: readonly DictionaryDraftEntry[],
): Promise<DictionaryDraftCheck> {
  if (!useBackend()) return mock.checkDictionaryDraft(draft)
  return request<DictionaryDraftCheck>(
    '/dictionary/check', { method: 'POST', body: { draft } },
  )
}

export async function previewInspection(
  text: string, draft?: readonly DictionaryDraftEntry[],
): Promise<DictionaryPreview> {
  if (!useBackend()) return mock.previewInspection(text, draft)
  return request<DictionaryPreview>(
    '/dictionary/preview', { method: 'POST', body: { text, draft: draft ?? null } },
  )
}

export async function saveDictionary(input: {
  baseRevision: number
  entries: DictionaryDraftEntry[]
}): Promise<DictionarySnapshot> {
  if (!useBackend()) return mock.saveDictionary(input)
  return request<DictionarySnapshot>(
    '/dictionary', { method: 'PUT', body: { draft: input.entries, baseRevision: input.baseRevision } },
  )
}

/* ── 사용자 · 권한 ──────────────────────────────────────────────────── */

export async function listUsers(): Promise<UserDirectory> {
  if (!useBackend()) return mock.listUsers()
  return request<UserDirectory>('/users')
}

export async function assignRole(userId: string, role: UserRole): Promise<ManagedUser> {
  if (!useBackend()) return mock.assignRole(userId, role)
  return request<ManagedUser>(
    `/users/${encodeURIComponent(userId)}/role`, { method: 'PUT', body: { role } },
  )
}

export async function listRoleChanges(limit = 5): Promise<RoleChangeEntry[]> {
  if (!useBackend()) return mock.listRoleChanges(limit)
  return request<RoleChangeEntry[]>(`/role-changes?limit=${limit}`)
}

/* ── 시연 초기화 ────────────────────────────────────────────────────── */

export async function resetDemoState(): Promise<void> {
  if (!useBackend()) return mock.resetDemoState()
  await request<{ ok: boolean }>('/demo/reset', { method: 'POST' })
}

/* ── 시험용 도우미 ──────────────────────────────────────────────────── */
// 목 전용이다. 백엔드 모드에서는 화면 동작에 영향을 주지 않는다.

export const setMockDelayRange = mock.setMockDelayRange
export const resetMockDelayRange = mock.resetMockDelayRange
export const resetMockDictionary = mock.resetMockDictionary
export const resetMockUsers = mock.resetMockUsers
