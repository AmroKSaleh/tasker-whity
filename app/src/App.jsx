import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { SessionProvider } from './auth/SessionProvider'
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
import InvitePage from './pages/InvitePage'
import PingCheck from './dev/PingCheck'
import RouteNotAvailable from './components/layout/RouteNotAvailable'

// Slice-one scope: these pages' backends have not been ported to the
// whity-core host yet, so the routes below render a shared placeholder
// instead of the real page. The imports above and the page files themselves
// are left untouched — this is about reachability only. Restoring a route
// is a one-line change back to its real element (see the commented-out
// originals below each guarded route). Deliberately NOT applied to
// SettingsPage: it is in scope for slice one (its webhooks/connectors
// sections are a separate, later concern).
// Guarded: FlowsPage, OrganizationsPage, GmailPanelPage, GoogleTasksPage,
// InvitePage, OAuthAuthorizePage.

export default function App() {
  return (
    <BrowserRouter>
      <SessionProvider>
        <Routes>
          <Route path="/dev/ping" element={<PingCheck />} />
          <Route path="/" element={<Navigate to="/home" replace />} />
          <Route path="/today" element={<Navigate to="/home" replace />} />
          <Route path="/home" element={<AuthGuard><TodayPage /></AuthGuard>} />
          <Route path="/projects" element={<AuthGuard><HomePage /></AuthGuard>} />
          <Route path="/environments" element={<AuthGuard><EnvironmentsPage /></AuthGuard>} />
          <Route path="/organizations" element={<AuthGuard><RouteNotAvailable /></AuthGuard>} />
          {/* <Route path="/organizations" element={<AuthGuard><OrganizationsPage /></AuthGuard>} /> */}
          <Route path="/flows" element={<AuthGuard><RouteNotAvailable /></AuthGuard>} />
          {/* <Route path="/flows" element={<AuthGuard><FlowsPage /></AuthGuard>} /> */}
          <Route path="/login" element={<LoginPage />} />
          <Route path="/invite/:token" element={<RouteNotAvailable />} />
          {/* <Route path="/invite/:token" element={<InvitePage />} /> */}
          <Route path="/docs/*" element={<DocsPage />} />
          <Route path="/docsV2/*" element={<DocsV2Page />} />
          <Route path="/oauth/authorize" element={<RouteNotAvailable />} />
          {/* <Route path="/oauth/authorize" element={<OAuthAuthorizePage />} /> */}
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
          <Route path="/connectors/gmail" element={<AuthGuard><RouteNotAvailable /></AuthGuard>} />
          {/* <Route path="/connectors/gmail" element={<AuthGuard><GmailPanelPage /></AuthGuard>} /> */}
          <Route path="/connectors/google-tasks" element={<AuthGuard><RouteNotAvailable /></AuthGuard>} />
          {/* <Route path="/connectors/google-tasks" element={<AuthGuard><GoogleTasksPage /></AuthGuard>} /> */}
        </Routes>
      </SessionProvider>
    </BrowserRouter>
  )
}
