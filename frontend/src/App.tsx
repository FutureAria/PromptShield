import { Navigate, Route, Routes } from 'react-router-dom'
import { RequireRole } from './auth/RequireRole'
import { SessionProvider } from './auth/SessionContext'
import { SiteHeader } from './components/SiteHeader'
import { AdminLayout } from './components/AdminLayout'
import AdminDashboardPage from './pages/AdminDashboardPage'
import ApprovalsPage from './pages/ApprovalsPage'
import AuditLogsPage from './pages/AuditLogsPage'
import EmployeePage from './pages/EmployeePage'
import LoginPage from './pages/LoginPage'
import './styles/auth.css'

const employeeRoles = ['employee', 'approver', 'auditor'] as const
const adminRoles = ['approver', 'auditor'] as const

export default function App() {
  return (
    <SessionProvider>
      <a className="skip-link" href="#main-content">본문으로 건너뛰기</a>
      <SiteHeader />
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route
          path="/"
          element={(
            <RequireRole allow={employeeRoles}>
              <EmployeePage />
            </RequireRole>
          )}
        />
        <Route
          element={(
            <RequireRole allow={adminRoles}>
              <AdminLayout />
            </RequireRole>
          )}
        >
          <Route path="/admin" element={<AdminDashboardPage />} />
          <Route path="/admin/logs" element={<AuditLogsPage />} />
        </Route>
        <Route
          element={(
            <RequireRole allow={['approver']}>
              <AdminLayout />
            </RequireRole>
          )}
        >
          <Route path="/admin/approvals" element={<ApprovalsPage />} />
        </Route>
        <Route path="*" element={<Navigate replace to="/" />} />
      </Routes>
    </SessionProvider>
  )
}
