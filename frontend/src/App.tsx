import { Navigate, Route, Routes } from 'react-router-dom'
import { SiteHeader } from './components/SiteHeader'
import { AdminLayout } from './components/AdminLayout'
import AdminDashboardPage from './pages/AdminDashboardPage'
import ApprovalsPage from './pages/ApprovalsPage'
import AuditLogsPage from './pages/AuditLogsPage'
import EmployeePage from './pages/EmployeePage'

export default function App() {
  return (
    <>
      <a className="skip-link" href="#main-content">본문으로 건너뛰기</a>
      <SiteHeader />
      <Routes>
        <Route path="/" element={<EmployeePage />} />
        <Route element={<AdminLayout />}>
          <Route path="/admin" element={<AdminDashboardPage />} />
          <Route path="/admin/logs" element={<AuditLogsPage />} />
          <Route path="/admin/approvals" element={<ApprovalsPage />} />
        </Route>
        <Route path="*" element={<Navigate replace to="/" />} />
      </Routes>
    </>
  )
}
