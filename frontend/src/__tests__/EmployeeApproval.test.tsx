import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  decideApproval,
  getPendingApprovals,
  resetMockDelayRange,
  setMockDelayRange,
} from '../api'
import ApprovalsPage from '../pages/ApprovalsPage'
import EmployeePage from '../pages/EmployeePage'

const blockedPrompt = '주민등록번호 000000-0000000 확인해줘'

async function requestApprovalFromEmployee(prompt = blockedPrompt) {
  const user = userEvent.setup()
  const approvalsBefore = await getPendingApprovals()
  render(<EmployeePage />)

  await user.type(screen.getByRole('textbox', { name: 'AI에게 보낼 내용' }), prompt)
  await user.click(screen.getByRole('button', { name: '검사' }))
  await user.click(await screen.findByRole('button', { name: '관리자 승인 요청' }))
  await screen.findByText('관리자 승인을 기다리는 중')

  const approvalsAfter = await getPendingApprovals()
  const createdApproval = approvalsAfter.find((approval) => (
    !approvalsBefore.some(({ id }) => id === approval.id)
  ))
  expect(createdApproval).toBeDefined()

  return { createdApproval: createdApproval!, user }
}

describe('직원 승인 왕복 화면', () => {
  beforeEach(() => {
    setMockDelayRange(0, 0)
    sessionStorage.clear()
  })

  afterEach(() => {
    cleanup()
    sessionStorage.clear()
    resetMockDelayRange()
  })

  it('위험 요청의 승인 대기 안내와 요청 흔적을 대화 이력에 남긴다', async () => {
    await requestApprovalFromEmployee()

    const conversation = screen.getByRole('heading', { name: '대화' }).closest('section')
    expect(conversation).not.toBeNull()
    expect(within(conversation!).getByText(blockedPrompt)).toBeVisible()
    expect(within(conversation!).getByText('승인 요청함')).toBeVisible()
  })

  it('관리자가 반려하면 폴링으로 반려 사유 전문을 표시한다', async () => {
    const rejectionReason = '고유식별정보를 제거한 뒤 다시 요청해 주세요.'
    const { createdApproval } = await requestApprovalFromEmployee(
      '반려 화면 테스트 주민등록번호 444444-4444444 확인해줘',
    )

    await decideApproval(createdApproval.id, 'rejected', rejectionReason)

    expect(await screen.findByText(
      '관리자가 반려했다',
      {},
      { timeout: 4_500 },
    )).toBeVisible()
    expect((await screen.findAllByText(
      rejectionReason,
      {},
      { timeout: 4_500 },
    )).length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: '수정 후 재검사' })).toBeEnabled()
  }, 7_000)

  it('관리자 화면 왕복 뒤 조건부 승인된 마스킹본을 전송한다', async () => {
    const { createdApproval } = await requestApprovalFromEmployee()

    cleanup()
    render(<ApprovalsPage />)

    const requestId = await screen.findByText(`요청 ${createdApproval.requestId}`)
    const approvalCard = requestId.closest('article')
    expect(approvalCard).not.toBeNull()

    const admin = userEvent.setup()
    await admin.click(within(approvalCard!).getByRole('button', {
      name: /조건부 승인.*마스킹본 전송/,
    }))
    await screen.findByText('마스킹본 전송으로 조건부 승인했다.')

    cleanup()
    render(<EmployeePage />)

    expect(await screen.findByText(
      '관리자가 마스킹본 전송을 조건으로 승인했다',
    )).toBeVisible()

    const employee = userEvent.setup()
    await employee.click(screen.getByRole('button', { name: '마스킹본 전송' }))

    expect(await screen.findByText(
      /관리자의 조건부 승인에 따라 민감정보를 마스킹한 전송본으로 처리했다/,
    )).toBeVisible()
    expect(screen.getByText('처리 경로 · 마스킹 후 전달')).toBeVisible()
    expect(sessionStorage.getItem('promptshield.pendingApprovalRequestId')).toBeNull()
  })
})
