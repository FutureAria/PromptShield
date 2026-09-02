import { useEffect, useMemo, useState } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router-dom'
import { listDemoAccounts, ROLE_LABELS } from '../api'
import type { DemoAccount, UserRole } from '../api/types'
import { useSession } from '../auth/SessionContext'

const defaultRouteByRole: Record<UserRole, string> = {
  employee: '/',
  approver: '/admin/approvals',
  auditor: '/admin/logs',
}

function getReturnPath(state: unknown): string | null {
  if (typeof state !== 'object' || state === null || !('from' in state)) {
    return null
  }

  const from = state.from
  if (typeof from !== 'object' || from === null || !('pathname' in from)) {
    return null
  }

  const pathname = from.pathname
  if (typeof pathname !== 'string' || !pathname.startsWith('/') || pathname.startsWith('//')) {
    return null
  }

  const search = 'search' in from && typeof from.search === 'string' ? from.search : ''
  const hash = 'hash' in from && typeof from.hash === 'string' ? from.hash : ''
  const target = `${pathname}${search}${hash}`

  return pathname === '/login' ? null : target
}

export default function LoginPage() {
  const { session, signIn, isLoading } = useSession()
  const location = useLocation()
  const navigate = useNavigate()
  const [accounts, setAccounts] = useState<DemoAccount[]>([])
  const [accountsLoading, setAccountsLoading] = useState(true)
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null)
  const [error, setError] = useState('')
  const returnPath = useMemo(() => getReturnPath(location.state), [location.state])

  useEffect(() => {
    let active = true

    async function loadAccounts() {
      try {
        const nextAccounts = await listDemoAccounts()
        if (active) {
          setAccounts(nextAccounts)
        }
      } catch {
        if (active) {
          setError('데모 계정 목록을 불러오지 못했다. 잠시 후 다시 시도해 주세요.')
        }
      } finally {
        if (active) {
          setAccountsLoading(false)
        }
      }
    }

    void loadAccounts()
    return () => {
      active = false
    }
  }, [])

  // signIn이 세션 상태를 먼저 갱신해도 클릭 핸들러가 역할별 목적지로 이동할 때까지
  // 로그인 화면의 일반적인 '/' 리다이렉트가 경합하지 않게 한다.
  if (session && !selectedUserId) {
    return <Navigate replace to={returnPath ?? '/'} />
  }

  async function handleSignIn(account: DemoAccount) {
    setSelectedUserId(account.userId)
    setError('')

    try {
      const nextSession = await signIn(account.userId)
      navigate(returnPath ?? defaultRouteByRole[nextSession.role], { replace: true })
    } catch {
      setError('로그인하지 못했다. 계정을 다시 선택해 주세요.')
    } finally {
      setSelectedUserId(null)
    }
  }

  return (
    <main className="login-page" id="main-content">
      <section className="login-panel" aria-labelledby="login-heading">
        <header className="login-intro">
          <p className="login-intro__eyebrow">AI 입력 보안 게이트웨이</p>
          <h1 id="login-heading">PromptShield</h1>
          <p>
            생성형 AI로 보내기 전에 업무 요청을 검사하고 안전한 처리 경로를 안내한다.
          </p>
        </header>

        <aside className="demo-account-notice" aria-label="데모 로그인 안내">
          <strong>데모 로그인 안내</strong>
          <p>데모용 계정 선택 화면이다. 실제 배포에서는 사내 계정 인증으로 대체한다.</p>
        </aside>

        <div className="account-picker">
          <div className="account-picker__heading">
            <h2>계정을 선택하세요</h2>
            <p>역할에 따라 볼 수 있는 화면과 처리할 수 있는 업무가 달라진다.</p>
          </div>

          {accountsLoading ? (
            <p className="account-picker__status" aria-live="polite">계정 목록을 불러오는 중이다.</p>
          ) : (
            <ul className="demo-account-list">
              {accounts.map((account) => {
                const isSelected = selectedUserId === account.userId
                const accountId = `demo-account-${account.userId}`

                return (
                  <li key={account.userId}>
                    <button
                      aria-describedby={`${accountId}-department ${accountId}-description`}
                      aria-labelledby={`${accountId}-name ${accountId}-role ${accountId}-action`}
                      className="demo-account-card"
                      disabled={isLoading}
                      type="button"
                      onClick={() => void handleSignIn(account)}
                    >
                      <span className="demo-account-card__heading">
                        <strong id={`${accountId}-name`}>{account.name}</strong>
                        <span className="role-badge" id={`${accountId}-role`}>
                          {ROLE_LABELS[account.role]}
                        </span>
                      </span>
                      <span
                        className="demo-account-card__department"
                        id={`${accountId}-department`}
                      >
                        {account.department}
                      </span>
                      <span
                        className="demo-account-card__description"
                        id={`${accountId}-description`}
                      >
                        {account.description}
                      </span>
                      <span className="demo-account-card__action" id={`${accountId}-action`}>
                        {isSelected ? '로그인하는 중' : '이 계정으로 시작'}
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}

          {error && <p className="login-error" role="alert">{error}</p>}
        </div>
      </section>
    </main>
  )
}
