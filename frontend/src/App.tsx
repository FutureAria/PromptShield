import { Navigate, Route, Routes } from 'react-router-dom'
import { RequireCapability } from './auth/RequireRole'
import { SessionProvider } from './auth/SessionContext'
import { SiteHeader } from './components/SiteHeader'
import { AdminLayout } from './components/AdminLayout'
import AdminDashboardPage from './pages/AdminDashboardPage'
import ApprovalsPage from './pages/ApprovalsPage'
import AuditLogsPage from './pages/AuditLogsPage'
import DictionaryPage from './pages/DictionaryPage'
import EmployeePage from './pages/EmployeePage'
import LoginPage from './pages/LoginPage'
import UsersPage from './pages/UsersPage'
import './styles/auth.css'

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
            <RequireCapability capability="employee.inspect">
              <EmployeePage />
            </RequireCapability>
          )}
        />
        <Route
          element={(
            <RequireCapability capability="admin.dashboard.view">
              <AdminLayout />
            </RequireCapability>
          )}
        >
          <Route path="/admin" element={<AdminDashboardPage />} />
          <Route path="/admin/logs" element={<AuditLogsPage />} />
          <Route path="/admin/dictionary" element={<DictionaryPage />} />
          <Route path="/admin/users" element={<UsersPage />} />
        </Route>
        <Route
          element={(
            <RequireCapability capability="admin.approvals.decide">
              <AdminLayout />
            </RequireCapability>
          )}
        >
          <Route path="/admin/approvals" element={<ApprovalsPage />} />
        </Route>
        <Route path="*" element={<Navigate replace to="/" />} />
      </Routes>
    </SessionProvider>
  )
}
