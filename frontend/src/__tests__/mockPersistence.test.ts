import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DictionaryDraftEntry, DictionaryEntry } from '../api'

const MOCK_STATE_KEY = 'promptshield.mockState'
const MOCK_STATE_MAX_BYTES = 2 * 1024 * 1024

async function loadFreshApi() {
  vi.resetModules()
  return import('../api')
}

function toDraft(entries: readonly DictionaryEntry[]): DictionaryDraftEntry[] {
  return entries.map((entry) => ({
    rowId: entry.id,
    id: entry.id,
    term: entry.term,
    entryType: entry.entryType,
    grade: entry.grade,
    active: entry.active,
    note: entry.note,
  }))
}

describe('목 상태 sessionStorage 영속화', () => {
  beforeEach(() => {
    sessionStorage.clear()
  })

  afterEach(() => {
    sessionStorage.clear()
    vi.restoreAllMocks()
    vi.resetModules()
  })

  it('검사·승인·감사·사전·계정 상태를 한 키에서 복원하고 승인 전송을 이어간다', async () => {
    const api = await loadFreshApi()
    api.setMockDelayRange(0, 0)
    await api.login('sec-park')

    const approvedInspection = await api.inspect(
      '복원할 승인 주민등록번호 000000-0000000 확인해줘',
    )
    await api.reportFalsePositive(
      approvedInspection.requestId,
      approvedInspection.detections[0]!.id,
    )
    const approvedRequest = await api.requestApproval(approvedInspection.requestId)
    await api.decideApproval(approvedRequest.approvalId, 'approved')

    const pendingInspection = await api.inspect(
      '복원할 대기 주민등록번호 111111-1111111 확인해줘',
    )
    const pendingRequest = await api.requestApproval(pendingInspection.requestId)

    const dictionary = await api.getDictionary()
    await api.saveDictionary({
      baseRevision: dictionary.revision,
      entries: [
        ...toDraft(dictionary.entries),
        {
          rowId: 'persisted-term',
          term: '새로고침제품',
          entryType: 'product_code',
          grade: 'confidential',
          active: true,
          note: '영속화 시험',
        },
      ],
    })
    await api.assignRole('aud-lee', 'employee')

    const auditCount = (await api.getAuditLogs()).length
    const stored = sessionStorage.getItem(MOCK_STATE_KEY)
    expect(stored).not.toBeNull()
    expect(Object.keys(JSON.parse(stored!))).toEqual(expect.arrayContaining([
      'inspections',
      'inspectionOwners',
      'approvalStatuses',
      'pendingApprovals',
      'auditLogs',
      'dictionary',
      'accounts',
      'roleChanges',
    ]))

    const restored = await loadFreshApi()
    restored.setMockDelayRange(0, 0)

    expect(await restored.getInspection(approvedInspection.requestId)).toMatchObject({
      requestId: approvedInspection.requestId,
      originalText: approvedInspection.originalText,
    })
    await restored.login('aud-lee')
    expect(await restored.getInspection(approvedInspection.requestId)).toBeNull()
    await restored.login('sec-park')
    expect(await restored.getApprovalStatus(approvedInspection.requestId)).toMatchObject({
      state: 'approved',
    })
    await expect(restored.send(approvedInspection.requestId)).resolves.toMatchObject({
      route: 'external_llm',
    })

    expect(await restored.getInspection(pendingInspection.requestId)).not.toBeNull()
    expect(await restored.getApprovalStatus(pendingInspection.requestId)).toMatchObject({
      approvalId: pendingRequest.approvalId,
      state: 'pending',
    })
    expect(await restored.getPendingApprovals()).toContainEqual(expect.objectContaining({
      id: pendingRequest.approvalId,
    }))
    expect((await restored.getAuditLogs()).length).toBe(auditCount)
    expect((await restored.getDictionary()).entries).toContainEqual(expect.objectContaining({
      term: '새로고침제품',
    }))
    expect(await restored.listDemoAccounts()).toContainEqual(expect.objectContaining({
      userId: 'aud-lee',
      role: 'employee',
    }))
    expect(await restored.listRoleChanges()).toContainEqual(expect.objectContaining({
      targetName: '이감사',
      from: 'auditor',
      to: 'employee',
    }))
    expect((await restored.getDashboard()).falsePositiveReports).toBe(8)
  })

  it('2MB를 넘기기 전에 오래된 검사 결과부터 저장 스냅숏에서 덜어낸다', async () => {
    const api = await loadFreshApi()
    api.setMockDelayRange(0, 0)

    // ASCII 장문은 이메일 정규식의 실패 탐색이 의도치 않게 비싸므로 한글 본문으로 크기만 만든다.
    const first = await api.inspect('가'.repeat(300_000))
    const second = await api.inspect('나'.repeat(300_000))
    const stored = sessionStorage.getItem(MOCK_STATE_KEY)

    expect(stored).not.toBeNull()
    expect(new TextEncoder().encode(stored!).byteLength).toBeLessThanOrEqual(
      MOCK_STATE_MAX_BYTES,
    )
    const parsed = JSON.parse(stored!) as {
      inspections: [string, unknown][]
      inspectionOwners: [string, string | null][]
    }
    expect(parsed.inspections.map(([requestId]) => requestId)).toEqual([second.requestId])
    expect(parsed.inspections.map(([requestId]) => requestId)).not.toContain(first.requestId)
    expect(parsed.inspectionOwners.map(([requestId]) => requestId)).toEqual([second.requestId])
  })

  it('손상된 스냅숏은 부분 복원하지 않고 씨앗 상태로 폴백한다', async () => {
    sessionStorage.setItem(MOCK_STATE_KEY, JSON.stringify({
      version: 1,
      inspections: 'broken',
    }))

    const api = await loadFreshApi()
    api.setMockDelayRange(0, 0)
    await api.login('sec-park')

    expect(await api.getPendingApprovals()).toHaveLength(4)
    expect(await api.getAuditLogs()).toHaveLength(52)
    expect((await api.getDictionary()).entries).toHaveLength(3)
    expect(await api.listDemoAccounts()).toHaveLength(4)
  })

  it('저장소 예외에도 메모리 기능을 유지하고 승인자 초기화는 로그인 세션을 보존한다', async () => {
    const failingSetItem = vi.spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => {
        throw new DOMException('quota', 'QuotaExceededError')
      })
    const apiWithBlockedStorage = await loadFreshApi()
    apiWithBlockedStorage.setMockDelayRange(0, 0)
    await expect(apiWithBlockedStorage.inspect('메모리 검사')).resolves.toMatchObject({
      grade: 'normal',
    })
    failingSetItem.mockRestore()

    const api = await loadFreshApi()
    api.setMockDelayRange(0, 0)
    await api.login('aud-lee')
    await expect(api.resetDemoState()).rejects.toThrow(
      '시연 데이터를 초기화할 권한이 없다.',
    )

    await api.login('sec-park')
    await api.inspect('초기화 전에 저장할 검사')
    expect(sessionStorage.getItem(MOCK_STATE_KEY)).not.toBeNull()
    const sessionBefore = sessionStorage.getItem('promptshield.session')

    await api.resetDemoState()

    expect(sessionStorage.getItem(MOCK_STATE_KEY)).toBeNull()
    expect(sessionStorage.getItem('promptshield.session')).toBe(sessionBefore)
    expect(await api.getPendingApprovals()).toHaveLength(4)
    expect(await api.getAuditLogs()).toHaveLength(52)
    expect((await api.getDictionary()).revision).toBe(1)
    expect(await api.listRoleChanges()).toEqual([])
  })
})
