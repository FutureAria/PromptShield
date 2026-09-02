import { Link, Navigate, useLocation } from 'react-router-dom'
import type { ReactNode } from 'react'
import type { UserRole } from '../api/types'
import { useSession } from './SessionContext'

interface RequireRoleProps {
  allow: readonly UserRole[]
  children: ReactNode
}

const roleLabels: Record<UserRole, string> = {
  employee: '직원',
  approver: '승인자',
  auditor: '감사자',
}

function AccessDenied({ role }: { role: UserRole }) {
  return (
    <main className="access-denied-page" id="main-content">
      <section className="access-denied-card" aria-labelledby="access-denied-heading">
        <span className="role-badge">{roleLabels[role]}</span>
        <h1 id="access-denied-heading">이 화면을 볼 권한이 없다</h1>
        <p>
          현재 계정에 허용된 화면으로 이동해 주세요. 권한이 필요하다면 사내 관리자에게 요청해야 한다.
        </p>
        <nav className="access-denied-links" aria-label="접근 가능한 화면">
          <Link className="button button--primary" to="/">
            직원 화면으로 가기
          </Link>
          {role === 'approver' && (
            <Link className="button" to="/admin/approvals">
              승인 대기로 가기
            </Link>
          )}
          {role === 'auditor' && (
            <Link className="button" to="/admin/logs">
              감사 로그로 가기
            </Link>
          )}
        </nav>
      </section>
    </main>
  )
}

export function RequireRole({ allow, children }: RequireRoleProps) {
  const { session, isLoading } = useSession()
  const location = useLocation()

  if (isLoading) {
    return (
      <main className="session-check" id="main-content" aria-live="polite">
        <p>세션을 확인하는 중이다.</p>
      </main>
    )
  }

  if (!session) {
    return <Navigate replace to="/login" state={{ from: location }} />
  }

  if (!allow.includes(session.role)) {
    return <AccessDenied role={session.role} />
  }

  return <>{children}</>
}

export default RequireRole
