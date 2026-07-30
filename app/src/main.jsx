import { StrictMode, lazy, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'

// window.__TASKER_LOCAL__ is injected by the local server (npx tasker).
// In local mode: no auth, no routing, no Supabase — just one repo's board.
const Root = window.__TASKER_LOCAL__
  ? lazy(() => import('./pages/LocalBoardPage.jsx'))
  : lazy(() => import('./App.jsx'))

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <Suspense fallback={null}>
      <Root />
    </Suspense>
  </StrictMode>,
)
