import { NavLink, useLocation } from 'react-router-dom'

export function SiteHeader() {
  const { pathname } = useLocation()
  const isAdmin = pathname.startsWith('/admin')

  return (
    <header className="site-header">
      <div className="site-header__inner">
        <NavLink className="brand" to="/" aria-label="PromptShield 직원 화면으로 이동">
          <span className="brand__mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none">
              <path d="M12 3 19 6v5c0 4.5-2.6 7.7-7 10-4.4-2.3-7-5.5-7-10V6l7-3Z" stroke="currentColor" strokeWidth="1.8" />
              <path d="m9 12 2 2 4-5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
          <span>PromptShield</span>
          <span className="brand__descriptor">AI 입력 보안 게이트웨이</span>
        </NavLink>

        <nav className="mode-switch" aria-label="사용자 화면 전환">
          <NavLink to="/" end aria-current={!isAdmin ? 'page' : undefined}>
            직원
          </NavLink>
          <NavLink to="/admin" aria-current={isAdmin ? 'page' : undefined}>
            관리자
          </NavLink>
        </nav>
      </div>
    </header>
  )
}
