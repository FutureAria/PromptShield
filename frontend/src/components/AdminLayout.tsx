import { NavLink, Outlet } from 'react-router-dom'
import { useSession } from '../auth/SessionContext'
import '../styles/admin.css'

export function AdminLayout() {
  const { session } = useSession()

  return (
    <div className="admin-shell">
      <aside className="admin-sidebar" aria-label="관리자 메뉴">
        <div className="admin-sidebar__heading">
          <span className="admin-sidebar__eyebrow">PromptShield</span>
          <strong>관리자</strong>
        </div>

        <nav className="admin-nav">
          <NavLink end to="/admin" className={({ isActive }) => isActive ? 'admin-nav__link is-active' : 'admin-nav__link'}>
            현황
          </NavLink>
          <NavLink to="/admin/logs" className={({ isActive }) => isActive ? 'admin-nav__link is-active' : 'admin-nav__link'}>
            감사 로그
          </NavLink>
          {session?.role === 'approver' && (
            <NavLink to="/admin/approvals" className={({ isActive }) => isActive ? 'admin-nav__link is-active' : 'admin-nav__link'}>
              승인 대기
            </NavLink>
          )}
        </nav>

        <p className="admin-sidebar__note">
          감사 기록에는 입력 원문과 탐지된 값을 남기지 않는다.
        </p>
      </aside>

      <main className="admin-main" id="main-content">
        <Outlet />
      </main>
    </div>
  )
}

export default AdminLayout
