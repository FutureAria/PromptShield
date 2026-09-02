import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  decideApproval,
  getApprovalStatus,
  inspect,
  requestApproval,
  resetMockDelayRange,
  send,
  setMockDelayRange,
} from '../api'

describe('승인 목 API 왕복', () => {
  beforeEach(() => {
    setMockDelayRange(0, 0)
  })

  afterEach(() => {
    resetMockDelayRange()
  })

  it('승인 전 상태를 pending으로 조회하고 승인 뒤 원문 전송을 허용한다', async () => {
    const inspection = await inspect('승인 테스트 주민등록번호 000000-0000000 확인해줘')
    expect(inspection.grade).toBe('blocked')

    const requested = await requestApproval(inspection.requestId)
    expect(await getApprovalStatus(inspection.requestId)).toMatchObject({
      approvalId: requested.approvalId,
      requestId: inspection.requestId,
      state: 'pending',
    })

    await decideApproval(requested.approvalId, 'approved')

    const approved = await getApprovalStatus(inspection.requestId)
    expect(approved).toMatchObject({
      approvalId: requested.approvalId,
      requestId: inspection.requestId,
      state: 'approved',
      decidedBy: '보안 관리자',
    })
    expect(approved?.decidedAt).toBeTruthy()

    const response = await send(inspection.requestId)
    expect(response.route).not.toBe('blocked')
  })

  it('반려 사유를 보존하고 반려된 요청의 전송을 막는다', async () => {
    const inspection = await inspect('반려 테스트 주민등록번호 111111-1111111 확인해줘')
    const requested = await requestApproval(inspection.requestId)
    const rejectionReason = '업무 목적을 확인할 수 없어 반려한다.'

    await decideApproval(requested.approvalId, 'rejected', rejectionReason)

    expect(await getApprovalStatus(inspection.requestId)).toMatchObject({
      state: 'rejected',
      rejectionReason,
    })
    await expect(send(inspection.requestId)).rejects.toThrow('관리자가 반려한 요청이다.')
  })

  it('조건부 승인 뒤 마스킹본을 외부 경로로 전송한다', async () => {
    const inspection = await inspect('조건부 테스트 주민등록번호 222222-2222222 확인해줘')
    const requested = await requestApproval(inspection.requestId)

    await decideApproval(requested.approvalId, 'conditional')

    expect(await getApprovalStatus(inspection.requestId)).toMatchObject({
      state: 'conditional',
    })
    await expect(send(inspection.requestId)).resolves.toMatchObject({
      route: 'masked_external',
    })
  })

  it('승인 요청 직후에는 전송할 수 없다', async () => {
    const inspection = await inspect('대기 테스트 주민등록번호 333333-3333333 확인해줘')

    await requestApproval(inspection.requestId)

    await expect(send(inspection.requestId)).rejects.toThrow(
      '관리자 승인 전에는 전송할 수 없다.',
    )
  })

  it('승인은 1회용이라 같은 요청을 다시 전송할 수 없다', async () => {
    const inspection = await inspect('재전송 테스트 주민등록번호 555555-5555555 확인해줘')
    const requested = await requestApproval(inspection.requestId)
    await decideApproval(requested.approvalId, 'approved')

    await expect(send(inspection.requestId)).resolves.toBeTruthy()

    await expect(send(inspection.requestId)).rejects.toThrow('이미 전송에 사용한 승인이다')
    expect(await getApprovalStatus(inspection.requestId)).toMatchObject({
      state: 'approved',
      consumedAt: expect.any(String),
    })
  })

  it('연속 호출이 겹쳐도 승인 한 건으로 두 번 전송되지 않는다', async () => {
    const inspection = await inspect('동시성 테스트 주민등록번호 666666-6666666 확인해줘')
    const requested = await requestApproval(inspection.requestId)
    await decideApproval(requested.approvalId, 'approved')

    const results = await Promise.allSettled([
      send(inspection.requestId),
      send(inspection.requestId),
    ])

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
  })
})
