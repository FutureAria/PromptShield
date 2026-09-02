import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import App from '../App'
import {
  decideApproval,
  getApprovalStatus,
  getAuditLogs,
  getPendingApprovals,
  inspect,
  login,
  logout,
  requestApproval,
  resetMockDelayRange,
  setMockDelayRange,
} from '../api'

function renderAppAt(pathname: string) {
  return render(
    <MemoryRouter
      future={{ v7_relativeSplatPath: true, v7_startTransition: true }}
      initialEntries={[pathname]}
    >
      <App />
    </MemoryRouter>,
  )
}

describe('역할 기반 인증과 라우트 가드', () => {
  beforeEach(() => {
    sessionStorage.clear()
    setMockDelayRange(0, 0)
  })

  afterEach(() => {
    cleanup()
    sessionStorage.clear()
    resetMockDelayRange()
  })

  it('로그인하지 않고 /admin에 접근하면 로그인 화면으로 이동한다', async () => {
    renderAppAt('/admin')

    const accountButton = await screen.findByRole('button', {
      name: /홍길동.*직원.*이 계정으로 시작/,
    })
    expect(accountButton).toBeVisible()

    await userEvent.setup().click(screen.getByRole('button', {
      name: /박보안.*승인자.*이 계정으로 시작/,
    }))
    expect(await screen.findByRole('heading', {
      name: '관리 현황',
      level: 1,
    })).toBeVisible()
  })

  it('직원으로 로그인하면 헤더에 관리자 링크가 없다', async () => {
    await login('emp-hong')

    renderAppAt('/')

    expect(screen.getByText('홍길동')).toBeVisible()
    expect(screen.queryByRole('link', { name: '관리자' })).not.toBeInTheDocument()
  })

  it('직원 세션으로 /admin에 직접 접근하면 로그인 화면이 아닌 접근 거부 화면이 나온다', async () => {
    await login('emp-hong')

    renderAppAt('/admin')

    expect(screen.getByRole('heading', {
      name: '이 화면을 볼 권한이 없다',
    })).toBeVisible()
    expect(screen.getByRole('link', { name: '직원 화면으로 가기' })).toBeVisible()
    expect(screen.queryByRole('button', {
      name: /홍길동.*직원.*이 계정으로 시작/,
    })).not.toBeInTheDocument()
  })

  it('감사자는 승인 대기 메뉴를 볼 수 없고 승인 화면에 직접 접근해도 거부된다', async () => {
    await login('aud-lee')

    renderAppAt('/admin/logs')

    expect(await screen.findByRole('heading', {
      name: '감사 로그',
      level: 1,
    })).toBeVisible()
    expect(screen.queryByRole('link', { name: '승인 대기' })).not.toBeInTheDocument()

    cleanup()
    renderAppAt('/admin')

    expect(await screen.findByRole('heading', {
      name: '관리 현황',
      level: 1,
    })).toBeVisible()
    expect(screen.queryByRole('link', {
      name: '전체 대기 요청 보기',
    })).not.toBeInTheDocument()

    cleanup()
    renderAppAt('/admin/approvals')

    expect(screen.getByRole('heading', {
      name: '이 화면을 볼 권한이 없다',
    })).toBeVisible()
    expect(screen.getByRole('link', { name: '감사 로그로 가기' })).toBeVisible()
  })

  it('승인자는 /admin/approvals에 들어갈 수 있다', async () => {
    await login('sec-park')
    const [pending] = await getPendingApprovals()
    expect(pending).toBeDefined()

    renderAppAt('/admin/approvals')

    expect(await screen.findByRole('heading', {
      name: '승인 대기',
      level: 1,
    })).toBeVisible()

    const requestId = await screen.findByText(`요청 ${pending!.requestId}`)
    const approvalCard = requestId.closest('article')
    expect(approvalCard).not.toBeNull()

    await userEvent.setup().click(within(approvalCard!).getByRole('button', {
      name: '승인',
    }))
    expect(await screen.findByText('요청을 승인했다.')).toBeVisible()

    expect(await getApprovalStatus(pending!.requestId)).toMatchObject({
      state: 'approved',
      decidedBy: '박보안',
    })
    expect(await getAuditLogs({ search: '박보안' })).toContainEqual(expect.objectContaining({
      userName: pending!.userName,
      department: pending!.department,
      approvedBy: '박보안',
    }))
  })
})

describe('목 API 역할 권한과 사용자 기록', () => {
  beforeEach(() => {
    sessionStorage.clear()
    setMockDelayRange(0, 0)
  })

  afterEach(() => {
    sessionStorage.clear()
    resetMockDelayRange()
  })

  it("직원 세션으로 decideApproval을 호출하면 '승인 처리 권한이 없다.' 오류가 난다", async () => {
    await login('emp-hong')

    await expect(decideApproval('approval-001', 'approved')).rejects.toThrow(
      '승인 처리 권한이 없다.',
    )
  })

  it("직원 세션으로 getAuditLogs를 호출하면 '관리자 권한이 없다.' 오류가 난다", async () => {
    await login('emp-hong')

    await expect(getAuditLogs()).rejects.toThrow('관리자 권한이 없다.')
  })

  it('로그인한 사용자가 승인 요청을 보내면 그 사용자 이름으로 기록한다', async () => {
    await login('emp-kim')
    const inspection = await inspect(
      '로그인 사용자 기록 테스트 주민등록번호 777777-7777777 확인해줘',
    )
    const requestPromise = requestApproval(inspection.requestId)
    await logout()
    const requested = await requestPromise
    const approvals = await getPendingApprovals()
    const created = approvals.find(({ id }) => id === requested.approvalId)

    expect(created).toMatchObject({
      userName: '김철수',
      department: '생산관리팀',
    })
  })
})
