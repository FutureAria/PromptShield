import { cleanup, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import App from '../App'
import {
  assignRole,
  can,
  listUsers,
  login,
  logout,
  resetMockDelayRange,
  resetMockDictionary,
  resetMockUsers,
  setMockDelayRange,
} from '../api'
import type { Capability, UserRole } from '../api'

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

describe('사용자·권한 API와 화면', () => {
  beforeEach(() => {
    sessionStorage.clear()
    setMockDelayRange(0, 0)
  })

  afterEach(() => {
    cleanup()
    sessionStorage.clear()
    resetMockDelayRange()
    resetMockDictionary()
    resetMockUsers()
  })

  it('감사자 화면은 조작 없는 조회 전용이다', async () => {
    await login('aud-lee')
    renderAppAt('/admin/users')

    expect(await screen.findByRole('heading', { name: '사용자·권한', level: 1 })).toBeVisible()
    expect(screen.queryAllByRole('combobox')).toEqual([])
    expect(screen.getByText(/조회 전용/)).toBeVisible()
  })

  it('직원은 역할을 바꿀 수 없다', async () => {
    await login('emp-hong')

    await expect(assignRole('emp-kim', 'approver')).rejects.toThrow(
      '역할을 배정할 권한이 없다.',
    )
  })

  it('마지막 승인자를 강등할 수 없다', async () => {
    await login('sec-park')
    await assignRole('aud-lee', 'approver')

    await login('aud-lee')
    await assignRole('sec-park', 'employee')

    // 세션 없는 목 직접 호출도 기존 계약상 권한 검사를 통과하지만,
    // 잠김 방지 규칙은 동일하게 적용되어 마지막 승인자 강등을 막는다.
    await logout()
    await expect(assignRole('aud-lee', 'auditor')).rejects.toThrow(
      /^승인자가 이감사 한 명뿐이다/,
    )
    expect((await listUsers()).roleCounts.approver).toBe(1)
  })

  it('본인 행에는 역할 드롭다운이 없다', async () => {
    await login('sec-park')
    renderAppAt('/admin/users')

    // 헤더에도 로그인 사용자 이름이 있으므로 표의 행 헤더를 직접 겨냥한다.
    const ownName = await screen.findByRole('rowheader', { name: '박보안' })
    const ownRow = ownName.closest('tr')
    expect(ownRow).not.toBeNull()
    expect(within(ownRow!).queryByRole('combobox')).not.toBeInTheDocument()
    expect(within(ownRow!).getByText('본인')).toBeVisible()
  })

  it('권한 매트릭스와 각 관리자 라우트 가드 결과가 일치한다', async () => {
    const accounts: ReadonlyArray<{ userId: string; role: UserRole }> = [
      { userId: 'emp-hong', role: 'employee' },
      { userId: 'sec-park', role: 'approver' },
      { userId: 'aud-lee', role: 'auditor' },
    ]
    const routes: ReadonlyArray<{
      path: string
      capability: Capability
      heading: string
    }> = [
      { path: '/admin', capability: 'admin.dashboard.view', heading: '관리 현황' },
      { path: '/admin/logs', capability: 'admin.logs.view', heading: '감사 로그' },
      { path: '/admin/approvals', capability: 'admin.approvals.decide', heading: '승인 대기' },
      { path: '/admin/users', capability: 'admin.users.view', heading: '사용자·권한' },
      { path: '/admin/dictionary', capability: 'admin.dictionary.view', heading: '기업 사전' },
    ]

    for (const account of accounts) {
      for (const route of routes) {
        cleanup()
        await login(account.userId)
        renderAppAt(route.path)

        if (can(account.role, route.capability)) {
          expect(await screen.findByRole('heading', {
            name: route.heading,
            level: 1,
          })).toBeVisible()
          expect(screen.queryByRole('heading', {
            name: '이 화면을 볼 권한이 없다',
          })).not.toBeInTheDocument()
        } else {
          expect(await screen.findByRole('heading', {
            name: '이 화면을 볼 권한이 없다',
          })).toBeVisible()
        }
      }
    }
  })
})
