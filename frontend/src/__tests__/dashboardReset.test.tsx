import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import App from '../App'
import {
  assignRole,
  can,
  listUsers,
  login,
  resetDemoState,
  resetMockDelayRange,
  setMockDelayRange,
} from '../api'

function renderDashboard() {
  return render(
    <MemoryRouter
      future={{ v7_relativeSplatPath: true, v7_startTransition: true }}
      initialEntries={['/admin']}
    >
      <App />
    </MemoryRouter>,
  )
}

async function resetDemoAsApprover() {
  await login('sec-park')
  await resetDemoState()
  sessionStorage.clear()
}

describe('시연 데이터 초기화 화면', () => {
  beforeEach(async () => {
    sessionStorage.clear()
    setMockDelayRange(0, 0)
    await resetDemoAsApprover()
  })

  afterEach(async () => {
    cleanup()
    sessionStorage.clear()
    await resetDemoAsApprover()
    resetMockDelayRange()
    sessionStorage.clear()
  })

  it('유일 권한 표에서 승인자에게만 초기화 능력을 준다', () => {
    expect(can('approver', 'admin.demo.reset')).toBe(true)
    expect(can('employee', 'admin.demo.reset')).toBe(false)
    expect(can('auditor', 'admin.demo.reset')).toBe(false)
  })

  it('감사자 대시보드에는 초기화 조작을 표시하지 않는다', async () => {
    await login('aud-lee')
    renderDashboard()

    expect(await screen.findByRole('heading', { name: '관리 현황', level: 1 })).toBeVisible()
    expect(screen.queryByRole('heading', { name: '시연용 데이터 초기화' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '시연 데이터 초기화' })).not.toBeInTheDocument()
  })

  it('승인자가 확인한 뒤 씨앗 값으로 되돌리고 현황을 다시 불러온다', async () => {
    const user = userEvent.setup()
    await login('sec-park')
    await assignRole('emp-kim', 'auditor')
    renderDashboard()

    expect(await screen.findByRole('heading', { name: '시연용 데이터 초기화' })).toBeVisible()
    await user.click(screen.getByRole('button', { name: '시연 데이터 초기화' }))

    expect(screen.getByText('지금껏 만든 시연 상태가 사라진다. 초기화할까?')).toBeVisible()
    expect((await listUsers()).users.find((account) => account.userId === 'emp-kim')?.role)
      .toBe('auditor')

    await user.click(screen.getByRole('button', { name: '초기화 실행' }))

    expect(await screen.findByRole('status')).toHaveTextContent('처음 상태로 돌렸다')
    expect(await screen.findByLabelText('승인 대기 4건')).toBeVisible()
    expect((await listUsers()).users.find((account) => account.userId === 'emp-kim')?.role)
      .toBe('employee')
    expect(sessionStorage.getItem('promptshield.session')).not.toBeNull()
    expect(sessionStorage.getItem('promptshield.mockState')).toBeNull()
  })
})
