import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import AuthGuard from './components/layout/AuthGuard'
import LoginPage from './pages/LoginPage'
import HomePage from './pages/HomePage'
import DashboardPage from './pages/DashboardPage'
import TodayPage from './pages/TodayPage'
import FlowsPage from './pages/FlowsPage'
import DocsPage from './pages/DocsPage'
import DocsV2Page from './pages/DocsV2Page'
import SettingsPage from './pages/SettingsPage'
import EnvironmentsPage from './pages/EnvironmentsPage'
import OrganizationsPage from './pages/OrganizationsPage'
import GmailPanelPage from './pages/GmailPanelPage'
import GoogleTasksPage from './pages/GoogleTasksPage'
import OAuthAuthorizePage from './pages/OAuthAuthorizePage'

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Navigate to="/home" replace />} />
        <Route path="/today" element={<Navigate to="/home" replace />} />
        <Route path="/home" element={<AuthGuard><TodayPage /></AuthGuard>} />
        <Route path="/projects" element={<AuthGuard><HomePage /></AuthGuard>} />
        <Route path="/environments" element={<AuthGuard><EnvironmentsPage /></AuthGuard>} />
        <Route path="/organizations" element={<AuthGuard><OrganizationsPage /></AuthGuard>} />
        <Route path="/flows" element={<AuthGuard><FlowsPage /></AuthGuard>} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/docs/*" element={<DocsPage />} />
        <Route path="/docsV2/*" element={<DocsV2Page />} />
        <Route path="/oauth/authorize" element={<OAuthAuthorizePage />} />
        <Route
          path="/dashboard/*"
          element={
            <AuthGuard>
              <DashboardPage />
            </AuthGuard>
          }
        />
        <Route
          path="/settings"
          element={
            <AuthGuard>
              <SettingsPage />
            </AuthGuard>
          }
        />
        <Route path="/connectors/gmail" element={<AuthGuard><GmailPanelPage /></AuthGuard>} />
        <Route path="/connectors/google-tasks" element={<AuthGuard><GoogleTasksPage /></AuthGuard>} />
      </Routes>
    </BrowserRouter>
  )
}
