# P1 — Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Tasker's Supabase authentication with whity-core's, and deploy whity's Next.js admin so every admin and account-self-service screen arrives free.

**Architecture:** whity's admin ships as a second frontend on its own port, proxying the API server-side, so nothing in pinned core is patched. Tasker's SPA implements only the login side — password, 2FA challenge, tenant selection, SSO start — against a small `app/src/api/auth.js` module. Account self-service (2FA setup, session revocation, email management) is deliberately *not* built: whity's admin already provides it.

**Tech Stack:** whity-core (pinned SHA), Next.js 16 admin, Node 20, Docker Compose, Caddy, React 19 + Vite, Vitest.

## Global Constraints

- Routes are versioned: call `/api/v1/…`. Only `/api/health`, `/api/version`, `/api/openapi.json` and `/mcp` are unversioned.
- Every request carries `X-Requested-With: XMLHttpRequest`, or `CsrfGuard` returns 403 before the handler runs. `apiFetch` supplies it; callers never do.
- Auth is an httpOnly cookie (`SameSite=Lax`). No token ever touches JavaScript in the browser flow.
- **Cookies are per-host, not per-port.** A cookie set on `localhost` is shared across `:5174`, `:8010` and `:3010`. This is what makes the admin and the SPA share one session — and it means port separation is not security isolation.
- `host/.core/` is gitignored, pinned to SHA `d4c74cdf016fa7c778d3f7931723acc400f04d41`, and **never patched**. The admin runs unmodified.
- Permission slugs take exactly one colon: `/^[a-z][a-z0-9_]*:[a-z][a-z0-9_]*$/`.
- Ports: `8010` API, `5174` Vite dev, `3010` admin, `5433` Postgres. Compose project `tasker`.
- The npm scripts are Windows/PowerShell-only. Do not add cross-platform work to this plan.

## Scope boundary — read this before reviewing anything

**P1 delivers authentication, not a working app.** The board still reads Supabase and will still be broken after this plan, because the board backend is D1 and the frontend swap is D2. That is the accepted cost of the platform-first sequencing in the roadmap spec.

So the smoke tests for P1 are **`/dev/ping`** (proving an authenticated, tenant-scoped API call from the SPA) and **the admin UI**, *not* the board. "The board doesn't work" is not a valid finding against this plan.

**Explicitly not built here** — whity's admin provides all of it: 2FA enrolment UI, session list and revocation UI, email add/verify/set-primary UI, registration approval, identity-provider configuration, 2FA policy configuration.

**Self-service registration is out of scope, deliberately, not by omission.** Tasker's SPA never had a public sign-up page — there is no `RegisterPage.jsx` in the app today, and `InvitePage.jsx` was already route-guarded off in Plan A. Building one now would be new UI, not a port. Until a real need for self-signup exists, accounts are provisioned through whity's admin (`POST /api/users`, reachable at `:3010/admin/users`). Add a registration page as its own slice if that changes.

## Prerequisites

Plan A complete (commit `200e149` or later on `trunk`). Docker Desktop running. `npm run setup` has been run, so `host/.core` exists and dependencies are installed.

---

### Task 1: Deploy whity's Next.js admin

**Files:**
- Modify: `host/docker-compose.yml`
- Modify: `host/.env.example`
- Modify: `package.json`
- Modify: `README.md`

**Interfaces:**
- Consumes: the running `frankenphp` service from Plan A.
- Produces: the admin UI at `http://localhost:3010`, sharing the session cookie with the SPA; npm script `admin:logs`.

- [ ] **Step 1: Add the admin service to `host/docker-compose.yml`**

Append this service. `WHITY_BACKEND_URL` is consumed by `web/app/api/[...path]/route.ts`, which proxies API calls **server-side** — so the browser only ever talks to `:3010`, and no CORS entry is needed.

```yaml
  admin:
    image: node:20
    container_name: tasker_admin
    working_dir: /app/web
    depends_on:
      frankenphp:
        condition: service_started
    environment:
      # Server-side proxy target: the backend's in-network address and port.
      WHITY_BACKEND_URL: http://frankenphp:80
      NEXT_PUBLIC_API_URL: /api
      NODE_ENV: production
      HOSTNAME: 0.0.0.0
    ports:
      - "3010:3000"
    volumes:
      - ./.core:/app
    command:
      - sh
      - -c
      - |
        set -e
        cd /app/web
        npm ci --no-audit --no-fund
        npm run build
        npm run start
```

- [ ] **Step 2: Record the admin variables in `host/.env.example`**

Append, with the comment — these are defaults the compose file already hardcodes, listed so the file documents the full surface:

```dotenv
# Admin UI (whity's Next.js app, served unmodified from host/.core/web)
# The browser talks only to :3010; the Next server proxies /api to the backend.
ADMIN_PORT=3010
```

- [ ] **Step 3: Add the log script to `package.json`**

Add to `scripts`:

```json
"admin:logs": "docker compose -f host/docker-compose.yml logs -f admin"
```

- [ ] **Step 4: Bring the admin up**

Run:

```powershell
npm run host:up
npm run admin:logs
```

Expected: `npm ci` then `next build` then `next start`. The first run is slow — Next builds the whole admin. Wait for `Ready in` before continuing. If the build OOMs or the container is killed, see the README's crash-loop troubleshooting note and reduce concurrency the same way.

- [ ] **Step 5: Verify the admin serves and can log in**

Run:

```powershell
(Invoke-WebRequest http://localhost:3010/login -UseBasicParsing).StatusCode
```

Expected: `200`.

Then open `http://localhost:3010/login` in a browser, log in as `admin@example.com` / `admin123`, and confirm you reach the dashboard.

- [ ] **Step 6: Verify the identity admin screens are reachable**

In the browser, visit `http://localhost:3010/admin/users` and `http://localhost:3010/admin/roles`.

Expected: both render with data. These are the screens that make Task 7's deletion of Tasker's own account UI safe. If they 403, the seeded admin lacks a permission — record which, and grant it via `/admin/roles` rather than by SQL.

- [ ] **Step 7: Document it in `README.md`**

Add to the dev-loop section, after the host URLs:

```markdown
- Admin UI (whity's, unmodified): <http://localhost:3010>

The admin is whity-core's own Next.js app, served straight from `host/.core/web`
with no patches, so it stays current with every core upgrade. It provides user,
role, OU, tenant, plugin, MCP-token and audit administration, plus account
self-service: 2FA enrolment, session revocation, and email management. Tasker's
own SPA deliberately does not duplicate these.

The browser only ever talks to `:3010`; that Next server proxies `/api` to the
backend in-network. Because cookies are scoped per host and ignore the port, one
login is shared across the SPA (`:5174`), the API (`:8010`) and the admin
(`:3010`).
```

- [ ] **Step 8: Commit**

```bash
git add host/docker-compose.yml host/.env.example package.json README.md
git commit -m "feat: deploy whity's Next.js admin alongside the Tasker SPA"
```

---

### Task 2: Harden `apiFetch` — 401 refresh and the 204 catch

Two changes the identity work depends on. The 401 refresh is what stops a 15-minute access token from logging users out mid-session; narrowing the JSON catch is a carried-forward item from Plan A's final review.

**Files:**
- Modify: `app/src/api/client.js`
- Test: `app/src/api/client.test.js`

**Interfaces:**
- Consumes: `apiFetch(path, options)` and `ApiError` from Plan A.
- Produces: `apiFetch` retries once after a successful `POST /api/v1/auth/refresh` on a 401; `setUnauthorizedHandler(fn)` for the app to react to a failed refresh; a 204 returns `null` while a malformed body on a 2xx still throws.

- [ ] **Step 1: Write the failing tests**

Add to `app/src/api/client.test.js`:

```javascript
describe('apiFetch 401 handling', () => {
  it('refreshes once and retries the original request', async () => {
    const calls = []
    const fetchMock = vi.fn(async (path) => {
      calls.push(path)
      if (path === '/api/v1/tasker/pings' && calls.filter((p) => p === '/api/v1/tasker/pings').length === 1) {
        return { ok: false, status: 401, json: async () => ({ error: 'Unauthorized' }) }
      }
      if (path === '/api/v1/auth/refresh') {
        return { ok: true, status: 200, json: async () => ({ data: {} }) }
      }
      return { ok: true, status: 200, json: async () => ({ data: [{ id: 1 }] }) }
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await apiFetch('/api/v1/tasker/pings')

    expect(result).toEqual({ data: [{ id: 1 }] })
    expect(calls).toEqual([
      '/api/v1/tasker/pings',
      '/api/v1/auth/refresh',
      '/api/v1/tasker/pings',
    ])
  })

  it('does not attempt a second refresh when the refresh itself 401s', async () => {
    const calls = []
    const fetchMock = vi.fn(async (path) => {
      calls.push(path)
      return { ok: false, status: 401, json: async () => ({ error: 'Unauthorized' }) }
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(apiFetch('/api/v1/me')).rejects.toMatchObject({ status: 401 })
    expect(calls).toEqual(['/api/v1/me', '/api/v1/auth/refresh'])
  })

  it('invokes the unauthorized handler when the refresh fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false, status: 401, json: async () => ({ error: 'Unauthorized' }),
    })))
    const onUnauthorized = vi.fn()
    setUnauthorizedHandler(onUnauthorized)

    await expect(apiFetch('/api/v1/me')).rejects.toMatchObject({ status: 401 })
    expect(onUnauthorized).toHaveBeenCalledTimes(1)

    setUnauthorizedHandler(null)
  })

  it('never tries to refresh the refresh endpoint itself', async () => {
    const calls = []
    vi.stubGlobal('fetch', vi.fn(async (path) => {
      calls.push(path)
      return { ok: false, status: 401, json: async () => ({ error: 'nope' }) }
    }))

    await expect(apiFetch('/api/v1/auth/refresh', { method: 'POST' })).rejects.toMatchObject({ status: 401 })
    expect(calls).toEqual(['/api/v1/auth/refresh'])
  })
})

describe('apiFetch body parsing', () => {
  it('still throws when a 200 carries a malformed body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => { throw new SyntaxError('Unexpected end of JSON input') },
    })))

    await expect(apiFetch('/api/v1/me')).rejects.toThrow(SyntaxError)
  })
})
```

Update the import at the top of the file to include the new export:

```javascript
import { apiFetch, ApiError, setUnauthorizedHandler } from './client'
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```powershell
npm run app:test
```

Expected: FAIL — `setUnauthorizedHandler` is not exported, and the malformed-200 test fails because the current catch swallows it into `null`.

- [ ] **Step 3: Implement**

In `app/src/api/client.js`, add the handler registry above `apiFetch`:

```javascript
const REFRESH_PATH = '/api/v1/auth/refresh'

let unauthorizedHandler = null

/**
 * Register a callback invoked when a 401 could not be recovered by refreshing.
 * The app uses this to clear session state and route to login.
 *
 * @param {(() => void) | null} fn
 */
export function setUnauthorizedHandler(fn) {
  unauthorizedHandler = fn
}
```

Restructure `apiFetch` so the request is issued by an inner helper and the 401 path retries exactly once:

```javascript
export async function apiFetch(path, options = {}) {
  let response = await sendRequest(path, options)

  // A 401 on anything except the refresh endpoint itself gets one recovery
  // attempt. Refreshing the refresh call would recurse.
  if (response.status === 401 && path !== REFRESH_PATH) {
    const refreshed = await sendRequest(REFRESH_PATH, { method: 'POST' })
    if (refreshed.ok) {
      response = await sendRequest(path, options)
    }
  }

  if (!response.ok) {
    if (response.status === 401) {
      unauthorizedHandler?.()
    }
    throw new ApiError(response.status, await errorMessage(response))
  }

  // 204 No Content carries no body at all; anything else that fails to parse
  // is a real error and must surface rather than becoming null.
  if (response.status === 204) {
    return null
  }

  return response.json()
}
```

Extract the two helpers `sendRequest` and `errorMessage` from the existing body, keeping the header construction exactly as it is — including the case-insensitive `x-requested-with` strip:

```javascript
/**
 * Issue one request with the mandated headers. No 401 handling here.
 *
 * @param {string} path
 * @param {{ method?: string, body?: unknown, headers?: Record<string,string> }} options
 * @returns {Promise<Response>}
 */
async function sendRequest(path, options = {}) {
  const { method = 'GET', body, headers = {} } = options

  const callerHeaders = Object.fromEntries(
    Object.entries(headers).filter(([key]) => key.toLowerCase() !== 'x-requested-with'),
  )

  const init = {
    method,
    credentials: 'include',
    headers: {
      ...callerHeaders,
      'X-Requested-With': 'XMLHttpRequest',
    },
  }

  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(body)
  }

  return fetch(path, init)
}

/**
 * Extract a human-readable message from an error response.
 *
 * @param {Response} response
 * @returns {Promise<string>}
 */
async function errorMessage(response) {
  try {
    const payload = await response.json()
    if (payload && typeof payload.error === 'string') return payload.error
    if (payload && typeof payload.message === 'string') return payload.message
  } catch {
    // Non-JSON error body — fall through to the generic message.
  }
  return `Request failed with status ${response.status}`
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:

```powershell
npm run app:test
```

Expected: PASS. Every pre-existing test must still pass — particularly the CSRF override-resistance test, which the header refactor must not weaken.

- [ ] **Step 5: Commit**

```bash
git add app/src/api/client.js app/src/api/client.test.js
git commit -m "feat: refresh once on 401 and stop masking malformed 2xx bodies"
```

---

### Task 3: The `auth.js` API module

**Files:**
- Create: `app/src/api/auth.js`
- Test: `app/src/api/auth.test.js`

**Interfaces:**
- Consumes: `apiFetch` from Task 2.
- Produces:
  - `login(email, password)` → `{ status: 'authenticated' | 'requires_2fa' | 'requires_tenant_selection', memberships?, user? }`
  - `completeTwoFactor(code)` → same shape
  - `selectTenant(tenantId)` → `{ status: 'authenticated', user }`
  - `getMe()` → the profile object
  - `getCapabilities()` → `string[]` of permission slugs
  - `logout()` → `null`
  - `getSsoProviders()` → `Array<{ id, name }>` (shape confirmed at runtime in Task 6)
  - `startSsoUrl(providerId)` → `string`

Login is a **three-state machine**, verified against `host/.core/src/Auth/AuthHandler.php`: a 202 with `{requires_2fa: true}`, a 200 with `{requires_tenant_selection: true, memberships: [...]}` where each membership is `{tenant_id, tenant_name, role}`, or a 200 meaning logged in. 2FA can be *followed* by tenant selection, so both callers must handle all three outcomes. In cookie mode the tenant-selection token is set as a short-lived cookie by the server; the client never sees it.

- [ ] **Step 1: Write the failing tests**

Create `app/src/api/auth.test.js`:

```javascript
import { describe, it, expect, vi, afterEach } from 'vitest'
import { login, completeTwoFactor, selectTenant, getCapabilities, logout, startSsoUrl } from './auth'

afterEach(() => {
  vi.unstubAllGlobals()
})

function stubJson(status, payload) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: status < 400,
    status,
    json: async () => payload,
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('login', () => {
  it('reports authenticated when the server returns a user', async () => {
    stubJson(200, { user: { id: 1, email: 'a@b.c', tenant_id: 1 } })

    const result = await login('a@b.c', 'pw')

    expect(result.status).toBe('authenticated')
    expect(result.user.email).toBe('a@b.c')
  })

  it('reports requires_2fa on a 202 challenge', async () => {
    stubJson(202, { requires_2fa: true })

    expect((await login('a@b.c', 'pw')).status).toBe('requires_2fa')
  })

  it('reports requires_tenant_selection and passes the memberships through', async () => {
    stubJson(200, {
      requires_tenant_selection: true,
      memberships: [
        { tenant_id: 1, tenant_name: 'Acme', role: 'admin' },
        { tenant_id: 2, tenant_name: 'Beta', role: 'member' },
      ],
    })

    const result = await login('a@b.c', 'pw')

    expect(result.status).toBe('requires_tenant_selection')
    expect(result.memberships).toHaveLength(2)
    expect(result.memberships[0]).toEqual({ tenant_id: 1, tenant_name: 'Acme', role: 'admin' })
  })

  it('posts to the versioned login route', async () => {
    const fetchMock = stubJson(200, { user: {} })

    await login('a@b.c', 'pw')

    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/login')
    expect(fetchMock.mock.calls[0][1].method).toBe('POST')
  })
})

describe('completeTwoFactor', () => {
  it('posts the code and can itself require tenant selection', async () => {
    const fetchMock = stubJson(200, {
      requires_tenant_selection: true,
      memberships: [{ tenant_id: 3, tenant_name: 'Gamma', role: 'member' }],
    })

    const result = await completeTwoFactor('123456')

    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/login/2fa')
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ code: '123456' })
    expect(result.status).toBe('requires_tenant_selection')
  })
})

describe('selectTenant', () => {
  it('posts tenant_id and reports authenticated', async () => {
    const fetchMock = stubJson(200, { user: { id: 1, tenant_id: 2 } })

    const result = await selectTenant(2)

    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/auth/select-tenant')
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ tenant_id: 2 })
    expect(result.status).toBe('authenticated')
  })
})

describe('getCapabilities', () => {
  it('unwraps the permissions array', async () => {
    stubJson(200, { data: { permissions: ['tasker_task:view', 'tasker_task:edit'] } })

    expect(await getCapabilities()).toEqual(['tasker_task:view', 'tasker_task:edit'])
  })

  it('returns an empty array when the shape is unexpected', async () => {
    stubJson(200, {})

    expect(await getCapabilities()).toEqual([])
  })
})

describe('logout', () => {
  it('posts to the logout route', async () => {
    const fetchMock = stubJson(204, null)

    await logout()

    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/auth/logout')
    expect(fetchMock.mock.calls[0][1].method).toBe('POST')
  })
})

describe('startSsoUrl', () => {
  it('builds the versioned start URL', () => {
    expect(startSsoUrl('google')).toBe('/api/v1/auth/sso/google/start')
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run:

```powershell
npm run app:test
```

Expected: FAIL — cannot resolve `./auth`.

- [ ] **Step 3: Implement**

Create `app/src/api/auth.js`:

```javascript
import { apiFetch } from './client'

/**
 * Interpret whity's login-family response as one of three outcomes.
 *
 * The server answers a login attempt in one of three ways (see
 * host/.core/src/Auth/AuthHandler.php): a 202 carrying requires_2fa, a 200
 * carrying requires_tenant_selection plus the caller's memberships, or a 200
 * meaning the session is established. 2FA completion can itself require tenant
 * selection, so both entry points share this interpreter.
 *
 * @param {any} payload
 * @returns {{status: 'authenticated'|'requires_2fa'|'requires_tenant_selection', memberships?: Array<{tenant_id:number,tenant_name:string,role:string}>, user?: any}}
 */
function interpret(payload) {
  if (payload?.requires_2fa) {
    return { status: 'requires_2fa' }
  }
  if (payload?.requires_tenant_selection) {
    return {
      status: 'requires_tenant_selection',
      memberships: Array.isArray(payload.memberships) ? payload.memberships : [],
    }
  }
  return { status: 'authenticated', user: payload?.user ?? payload?.data ?? null }
}

/**
 * Begin a password login.
 *
 * @param {string} email
 * @param {string} password
 */
export async function login(email, password) {
  return interpret(await apiFetch('/api/v1/login', { method: 'POST', body: { email, password } }))
}

/**
 * Answer a 2FA challenge. May itself return requires_tenant_selection.
 *
 * @param {string} code TOTP or recovery code.
 */
export async function completeTwoFactor(code) {
  return interpret(await apiFetch('/api/v1/login/2fa', { method: 'POST', body: { code } }))
}

/**
 * Choose a tenant after a requires_tenant_selection outcome. The short-lived
 * selection token travels as an httpOnly cookie the server set; the client
 * only supplies the chosen tenant.
 *
 * @param {number} tenantId
 */
export async function selectTenant(tenantId) {
  return interpret(
    await apiFetch('/api/v1/auth/select-tenant', { method: 'POST', body: { tenant_id: tenantId } }),
  )
}

/**
 * The signed-in profile. Throws ApiError(401) when there is no session.
 */
export async function getMe() {
  const payload = await apiFetch('/api/v1/me')
  return payload?.data ?? payload
}

/**
 * The caller's permission slugs, used to gate navigation fail-closed.
 *
 * @returns {Promise<string[]>}
 */
export async function getCapabilities() {
  const payload = await apiFetch('/api/v1/me/capabilities')
  const permissions = payload?.data?.permissions
  return Array.isArray(permissions) ? permissions : []
}

/** End the session. */
export async function logout() {
  return apiFetch('/api/v1/auth/logout', { method: 'POST' })
}

/**
 * Configured SSO providers, or an empty list when none are set up.
 *
 * @returns {Promise<Array<{id: string, name: string}>>}
 */
export async function getSsoProviders() {
  const payload = await apiFetch('/api/v1/auth/sso/providers')
  const providers = payload?.data ?? payload
  return Array.isArray(providers) ? providers : []
}

/**
 * The URL that begins an SSO redirect. This is a full-page navigation target,
 * not a fetch — the provider redirects the browser back to the callback.
 *
 * @param {string} providerId
 * @returns {string}
 */
export function startSsoUrl(providerId) {
  return `/api/v1/auth/sso/${encodeURIComponent(providerId)}/start`
}
```

- [ ] **Step 4: Run to verify pass**

Run:

```powershell
npm run app:test
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/api/auth.js app/src/api/auth.test.js
git commit -m "feat: auth API module for whity login, 2FA, tenant selection and SSO"
```

---

### Task 4: Session context and `AuthGuard`

**Files:**
- Create: `app/src/auth/SessionProvider.jsx`
- Test: `app/src/auth/SessionProvider.test.jsx`
- Modify: `app/src/components/layout/AuthGuard.jsx`
- Modify: `app/src/App.jsx`
- Modify: `app/vitest.config.js`

**Interfaces:**
- Consumes: `getMe`, `getCapabilities`, `logout`, `setUnauthorizedHandler`.
- Produces: `<SessionProvider>`; `useSession()` → `{ status: 'loading'|'authenticated'|'anonymous', user, capabilities, can(slug), refresh(), signOut() }`. `AuthGuard` renders children only when `status === 'authenticated'`, redirecting to `/login` when anonymous.

- [ ] **Step 1: Enable a DOM environment for component tests**

`app/vitest.config.js` currently uses `environment: 'node'`, which cannot render components. Change it and add the testing library:

```javascript
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['src/**/*.test.{js,jsx}'],
  },
})
```

Run:

```powershell
cd app; npm install -D jsdom @testing-library/react @testing-library/dom; cd ..
npm run app:test
```

Expected: the existing 8 tests still pass under jsdom. If any fail because they assumed Node, fix them before continuing — a green baseline is required before adding component tests.

- [ ] **Step 2: Write the failing test**

Create `app/src/auth/SessionProvider.test.jsx`:

```jsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { SessionProvider, useSession } from './SessionProvider'

vi.mock('../api/auth', () => ({
  getMe: vi.fn(),
  getCapabilities: vi.fn(),
  logout: vi.fn(),
}))
vi.mock('../api/client', () => ({
  setUnauthorizedHandler: vi.fn(),
}))

import { getMe, getCapabilities } from '../api/auth'

function Probe() {
  const { status, user, can } = useSession()
  return (
    <div>
      <span data-testid="status">{status}</span>
      <span data-testid="email">{user?.email ?? ''}</span>
      <span data-testid="can-edit">{String(can('tasker_task:edit'))}</span>
    </div>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('SessionProvider', () => {
  it('starts loading, then reports authenticated with capabilities', async () => {
    getMe.mockResolvedValue({ id: 1, email: 'a@b.c' })
    getCapabilities.mockResolvedValue(['tasker_task:edit'])

    render(<SessionProvider><Probe /></SessionProvider>)

    expect(screen.getByTestId('status').textContent).toBe('loading')

    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('authenticated'))
    expect(screen.getByTestId('email').textContent).toBe('a@b.c')
    expect(screen.getByTestId('can-edit').textContent).toBe('true')
  })

  it('reports anonymous when there is no session', async () => {
    getMe.mockRejectedValue(Object.assign(new Error('Unauthorized'), { status: 401 }))

    render(<SessionProvider><Probe /></SessionProvider>)

    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('anonymous'))
  })

  it('gates fail-closed: can() is false for a slug not held', async () => {
    getMe.mockResolvedValue({ id: 1, email: 'a@b.c' })
    getCapabilities.mockResolvedValue([])

    render(<SessionProvider><Probe /></SessionProvider>)

    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('authenticated'))
    expect(screen.getByTestId('can-edit').textContent).toBe('false')
  })
})
```

- [ ] **Step 3: Run to verify failure**

Run:

```powershell
npm run app:test
```

Expected: FAIL — cannot resolve `./SessionProvider`.

- [ ] **Step 4: Implement**

Create `app/src/auth/SessionProvider.jsx`:

```jsx
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { getMe, getCapabilities, logout as logoutRequest } from '../api/auth'
import { setUnauthorizedHandler } from '../api/client'

const SessionContext = createContext(null)

/**
 * Holds the signed-in profile and permission slugs for the whole app.
 *
 * Capabilities gate navigation FAIL-CLOSED: can() is false unless the slug is
 * present. Route-level RBAC on the server is the real enforcement; this only
 * decides what to show, so being wrong here must hide, never reveal.
 */
export function SessionProvider({ children }) {
  const [status, setStatus] = useState('loading')
  const [user, setUser] = useState(null)
  const [capabilities, setCapabilities] = useState([])

  const refresh = useCallback(async () => {
    try {
      const profile = await getMe()
      setUser(profile)
      setCapabilities(await getCapabilities())
      setStatus('authenticated')
    } catch {
      setUser(null)
      setCapabilities([])
      setStatus('anonymous')
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  // A 401 that survived apiFetch's refresh attempt means the session is gone.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      setUser(null)
      setCapabilities([])
      setStatus('anonymous')
    })
    return () => setUnauthorizedHandler(null)
  }, [])

  const signOut = useCallback(async () => {
    try {
      await logoutRequest()
    } finally {
      setUser(null)
      setCapabilities([])
      setStatus('anonymous')
    }
  }, [])

  const value = useMemo(
    () => ({
      status,
      user,
      capabilities,
      can: (slug) => capabilities.includes(slug),
      refresh,
      signOut,
    }),
    [status, user, capabilities, refresh, signOut],
  )

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}

/**
 * Access the session. Throws when used outside SessionProvider, which is a
 * developer error rather than a runtime condition.
 */
export function useSession() {
  const context = useContext(SessionContext)
  if (context === null) {
    throw new Error('useSession must be used inside a SessionProvider')
  }
  return context
}
```

- [ ] **Step 5: Run to verify pass**

Run:

```powershell
npm run app:test
```

Expected: PASS.

- [ ] **Step 6: Rewrite `AuthGuard` against the session**

Replace the body of `app/src/components/layout/AuthGuard.jsx` with the version below. Read the existing file first and keep any loading-spinner component it already uses rather than inventing new markup.

```jsx
import { Navigate } from 'react-router-dom'
import { useSession } from '../../auth/SessionProvider'

/**
 * Renders children only for an authenticated session. The server enforces
 * access on every request; this prevents rendering a shell that cannot load.
 */
export default function AuthGuard({ children }) {
  const { status } = useSession()

  if (status === 'loading') {
    return null
  }

  if (status === 'anonymous') {
    return <Navigate to="/login" replace />
  }

  return children
}
```

- [ ] **Step 7: Wrap the app**

In `app/src/App.jsx`, import the provider and wrap the existing router subtree so every route — including `/login` — can read the session:

```jsx
import { SessionProvider } from './auth/SessionProvider'
```

Wrap whatever element currently contains `<Routes>`:

```jsx
<SessionProvider>
  {/* existing router subtree unchanged */}
</SessionProvider>
```

- [ ] **Step 8: Verify the app still boots and `/dev/ping` works**

Run:

```powershell
npm run app:test
npm run dev
```

Open `http://localhost:5174/dev/ping` and run the check.

Expected: tests pass; the ping round trip still succeeds. `/dev/ping` logs in by itself, so it exercises the cookie path independently of the new login page.

- [ ] **Step 9: Commit**

```bash
git add app/src/auth app/src/components/layout/AuthGuard.jsx app/src/App.jsx app/vitest.config.js app/package.json
git commit -m "feat: session context and AuthGuard backed by whity /me"
```

---

### Task 5: LoginPage — password, 2FA challenge, tenant selection

The three-state machine from Task 3 becomes UI. This replaces Supabase auth in the page entirely.

**Files:**
- Modify: `app/src/pages/LoginPage.jsx`
- Test: `app/src/pages/LoginPage.test.jsx`

**Interfaces:**
- Consumes: `login`, `completeTwoFactor`, `selectTenant` from Task 3; `useSession().refresh` from Task 4.
- Produces: a login page whose internal `step` is `'credentials' | 'two_factor' | 'tenant'`.

- [ ] **Step 1: Write the failing test**

Create `app/src/pages/LoginPage.test.jsx`:

```jsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import LoginPage from './LoginPage'

vi.mock('../api/auth', () => ({
  login: vi.fn(),
  completeTwoFactor: vi.fn(),
  selectTenant: vi.fn(),
  getSsoProviders: vi.fn().mockResolvedValue([]),
  startSsoUrl: (id) => `/api/v1/auth/sso/${id}/start`,
}))
const refresh = vi.fn()
vi.mock('../auth/SessionProvider', () => ({
  useSession: () => ({ status: 'anonymous', refresh }),
}))

import { login, completeTwoFactor, selectTenant } from '../api/auth'

function setup() {
  return render(<MemoryRouter><LoginPage /></MemoryRouter>)
}

async function submitCredentials() {
  const { fireEvent } = await import('@testing-library/react')
  fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'a@b.c' } })
  fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'pw' } })
  fireEvent.click(screen.getByRole('button', { name: /sign in/i }))
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('LoginPage', () => {
  it('shows a 2FA code field when the server challenges', async () => {
    login.mockResolvedValue({ status: 'requires_2fa' })
    setup()
    await submitCredentials()

    await waitFor(() => expect(screen.getByLabelText(/code/i)).toBeTruthy())
  })

  it('shows the tenant list when selection is required', async () => {
    login.mockResolvedValue({
      status: 'requires_tenant_selection',
      memberships: [
        { tenant_id: 1, tenant_name: 'Acme', role: 'admin' },
        { tenant_id: 2, tenant_name: 'Beta', role: 'member' },
      ],
    })
    setup()
    await submitCredentials()

    await waitFor(() => expect(screen.getByRole('button', { name: /Acme/ })).toBeTruthy())
    expect(screen.getByRole('button', { name: /Beta/ })).toBeTruthy()
  })

  it('moves from the 2FA step to tenant selection when 2FA returns that', async () => {
    const { fireEvent } = await import('@testing-library/react')
    login.mockResolvedValue({ status: 'requires_2fa' })
    completeTwoFactor.mockResolvedValue({
      status: 'requires_tenant_selection',
      memberships: [{ tenant_id: 3, tenant_name: 'Gamma', role: 'member' }],
    })
    setup()
    await submitCredentials()
    await waitFor(() => screen.getByLabelText(/code/i))

    fireEvent.change(screen.getByLabelText(/code/i), { target: { value: '123456' } })
    fireEvent.click(screen.getByRole('button', { name: /verify/i }))

    await waitFor(() => expect(screen.getByRole('button', { name: /Gamma/ })).toBeTruthy())
  })

  it('refreshes the session once authenticated', async () => {
    login.mockResolvedValue({ status: 'authenticated', user: { id: 1 } })
    setup()
    await submitCredentials()

    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
  })

  it('surfaces the server error message on a failed login', async () => {
    login.mockRejectedValue(Object.assign(new Error('Invalid credentials'), { status: 401 }))
    setup()
    await submitCredentials()

    await waitFor(() => expect(screen.getByText(/Invalid credentials/)).toBeTruthy())
  })

  it('selects a tenant and then refreshes the session', async () => {
    const { fireEvent } = await import('@testing-library/react')
    login.mockResolvedValue({
      status: 'requires_tenant_selection',
      memberships: [{ tenant_id: 7, tenant_name: 'Delta', role: 'admin' }],
    })
    selectTenant.mockResolvedValue({ status: 'authenticated', user: { id: 1 } })
    setup()
    await submitCredentials()
    await waitFor(() => screen.getByRole('button', { name: /Delta/ }))

    fireEvent.click(screen.getByRole('button', { name: /Delta/ }))

    await waitFor(() => expect(selectTenant).toHaveBeenCalledWith(7))
    await waitFor(() => expect(refresh).toHaveBeenCalled())
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run:

```powershell
npm run app:test
```

Expected: FAIL — the current `LoginPage` uses Supabase and has none of these controls.

- [ ] **Step 3: Implement**

Rewrite `app/src/pages/LoginPage.jsx`. **Read the existing file first and preserve its visual structure** — the surrounding layout, headings, and Tailwind classes. Tasker's look is the asset being kept; only the auth logic changes. The state machine below is what must be true regardless of styling:

```jsx
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { login, completeTwoFactor, selectTenant } from '../api/auth'
import { useSession } from '../auth/SessionProvider'
import SsoButtons from '../components/layout/SsoButtons'

export default function LoginPage() {
  const [step, setStep] = useState('credentials')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [memberships, setMemberships] = useState([])
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  const { refresh } = useSession()
  const navigate = useNavigate()

  /** Route a login-family outcome to the next step. */
  async function applyOutcome(outcome) {
    if (outcome.status === 'requires_2fa') {
      setStep('two_factor')
      return
    }
    if (outcome.status === 'requires_tenant_selection') {
      setMemberships(outcome.memberships)
      setStep('tenant')
      return
    }
    await refresh()
    navigate('/dashboard', { replace: true })
  }

  /** Run an auth call, surfacing its message and never leaving the form busy. */
  async function attempt(fn) {
    setBusy(true)
    setError(null)
    try {
      await applyOutcome(await fn())
    } catch (e) {
      setError(e.message ?? 'Something went wrong')
    } finally {
      setBusy(false)
    }
  }

  if (step === 'two_factor') {
    return (
      <form onSubmit={(e) => { e.preventDefault(); attempt(() => completeTwoFactor(code)) }}>
        <h1>Two-factor code</h1>
        <label htmlFor="code">Authentication code</label>
        <input id="code" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" />
        {error && <p role="alert">{error}</p>}
        <button type="submit" disabled={busy}>Verify</button>
      </form>
    )
  }

  if (step === 'tenant') {
    return (
      <div>
        <h1>Choose a workspace</h1>
        {error && <p role="alert">{error}</p>}
        <ul>
          {memberships.map((m) => (
            <li key={m.tenant_id}>
              <button type="button" disabled={busy} onClick={() => attempt(() => selectTenant(m.tenant_id))}>
                {m.tenant_name} — {m.role}
              </button>
            </li>
          ))}
        </ul>
      </div>
    )
  }

  return (
    <form onSubmit={(e) => { e.preventDefault(); attempt(() => login(email, password)) }}>
      <h1>Sign in</h1>
      <label htmlFor="email">Email</label>
      <input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" />
      <label htmlFor="password">Password</label>
      <input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
      {error && <p role="alert">{error}</p>}
      <button type="submit" disabled={busy}>Sign in</button>
      <SsoButtons />
    </form>
  )
}
```

`SsoButtons` arrives in Task 6. Until then, create a one-line placeholder so this task's tests run: `app/src/components/layout/SsoButtons.jsx` exporting `export default function SsoButtons() { return null }`.

- [ ] **Step 4: Run to verify pass**

Run:

```powershell
npm run app:test
```

Expected: PASS, all six LoginPage tests.

- [ ] **Step 5: Commit**

```bash
git add app/src/pages/LoginPage.jsx app/src/pages/LoginPage.test.jsx app/src/components/layout/SsoButtons.jsx
git commit -m "feat: login page with 2FA challenge and tenant selection"
```

---

### Task 6: SSO buttons

**Files:**
- Modify: `app/src/components/layout/SsoButtons.jsx`
- Test: `app/src/components/layout/SsoButtons.test.jsx`

**Interfaces:**
- Consumes: `getSsoProviders`, `startSsoUrl` from Task 3.
- Produces: a component rendering one link per configured provider, or nothing when none are configured.

SSO is a **full-page navigation**, not a fetch: `/api/v1/auth/sso/{provider}/start` redirects to the provider, which redirects back to `/api/v1/auth/sso/{provider}/callback`. Rendering anchors rather than buttons is therefore correct.

- [ ] **Step 1: Write the failing test**

Create `app/src/components/layout/SsoButtons.test.jsx`:

```jsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import SsoButtons from './SsoButtons'

vi.mock('../../api/auth', () => ({
  getSsoProviders: vi.fn(),
  startSsoUrl: (id) => `/api/v1/auth/sso/${id}/start`,
}))

import { getSsoProviders } from '../../api/auth'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('SsoButtons', () => {
  it('renders nothing when no providers are configured', async () => {
    getSsoProviders.mockResolvedValue([])

    const { container } = render(<SsoButtons />)

    await waitFor(() => expect(getSsoProviders).toHaveBeenCalled())
    expect(container.querySelectorAll('a')).toHaveLength(0)
  })

  it('renders a start link per provider', async () => {
    getSsoProviders.mockResolvedValue([{ id: 'google', name: 'Google' }])

    render(<SsoButtons />)

    const link = await waitFor(() => screen.getByRole('link', { name: /Google/ }))
    expect(link.getAttribute('href')).toBe('/api/v1/auth/sso/google/start')
  })

  it('renders nothing when the providers call fails', async () => {
    getSsoProviders.mockRejectedValue(new Error('boom'))

    const { container } = render(<SsoButtons />)

    await waitFor(() => expect(getSsoProviders).toHaveBeenCalled())
    expect(container.querySelectorAll('a')).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run:

```powershell
npm run app:test
```

Expected: FAIL — the placeholder renders `null` unconditionally and has no `a` elements or fetch call.

- [ ] **Step 3: Implement**

Replace `app/src/components/layout/SsoButtons.jsx`:

```jsx
import { useEffect, useState } from 'react'
import { getSsoProviders, startSsoUrl } from '../../api/auth'

/**
 * One sign-in link per configured identity provider.
 *
 * Renders nothing when no providers exist or the lookup fails: SSO is optional
 * configuration, so its absence must never block password login.
 */
export default function SsoButtons() {
  const [providers, setProviders] = useState([])

  useEffect(() => {
    let cancelled = false
    getSsoProviders()
      .then((list) => { if (!cancelled) setProviders(list) })
      .catch(() => { if (!cancelled) setProviders([]) })
    return () => { cancelled = true }
  }, [])

  if (providers.length === 0) {
    return null
  }

  return (
    <div>
      {providers.map((p) => (
        <a key={p.id} href={startSsoUrl(p.id)}>
          Continue with {p.name}
        </a>
      ))}
    </div>
  )
}
```

- [ ] **Step 4: Run to verify pass**

Run:

```powershell
npm run app:test
```

Expected: PASS.

- [ ] **Step 5: Confirm the provider payload shape against the live host**

The tests assume `{id, name}`. Verify the real shape, since Task 3's JSDoc claims it:

```powershell
$s = New-Object Microsoft.PowerShell.Commands.WebRequestSession
$csrf = @{ 'X-Requested-With' = 'XMLHttpRequest' }
Invoke-RestMethod -Uri http://localhost:8010/api/v1/login -Method Post -ContentType 'application/json' -Headers $csrf -Body '{"email":"admin@example.com","password":"admin123"}' -WebSession $s | Out-Null
Invoke-RestMethod -Uri http://localhost:8010/api/v1/auth/sso/providers -WebSession $s | ConvertTo-Json -Depth 5
```

Expected: a list (empty until a provider is configured in the admin). If the element keys differ from `id`/`name`, correct `SsoButtons.jsx`, its test, and `auth.js`'s JSDoc together, and record the real shape in your report.

- [ ] **Step 6: Commit**

```bash
git add app/src/components/layout/SsoButtons.jsx app/src/components/layout/SsoButtons.test.jsx
git commit -m "feat: SSO sign-in links from configured identity providers"
```

---

### Task 7: Remove Supabase auth, verify end to end, document

**Files:**
- Modify: `app/src/pages/OAuthAuthorizePage.jsx` (delete) and `app/src/App.jsx`
- Modify: `README.md`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: everything above.
- Produces: no Supabase import in any auth path; CI covering the admin build.

- [ ] **Step 1: Find every remaining Supabase auth usage**

Run:

```powershell
Select-String -Path app/src -Include *.js,*.jsx -Recurse -Pattern "supabase\.auth|signInWith|signOut\(|onAuthStateChange|getSession" | Select-Object Path,LineNumber,Line
```

Record the full list in your report. Replace each with the session context or the `auth.js` module. Files that use Supabase for **data** are out of scope — D2 handles those. Only auth usages change here.

- [ ] **Step 2: Delete the superseded OAuth page**

`OAuthAuthorizePage.jsx` implemented Tasker's own OAuth authorize screen against Supabase. whity's SSO and its admin replace it, and Plan A already route-guarded it. Delete the file and its route and import from `App.jsx`.

Note in your report that a background security scan previously flagged an authorization-bypass and a UI-spoofing risk in this file. Deleting it resolves both; say so explicitly, since the spec's debt table tracks them as fix-on-touch.

- [ ] **Step 3: Run the suite**

Run:

```powershell
npm run app:test
npm run plugin:test
npm run plugin:stan
```

Expected: all green.

- [ ] **Step 4: Verify the real login flow in a browser**

Run:

```powershell
npm run host:up
npm run dev
```

Then, at `http://localhost:5174/login`, sign in as `admin@example.com` / `admin123`.

Expected: you land on the dashboard shell (the board itself will fail to load — that is D2's job, not a defect). Confirm all four:

1. `document.cookie` in the console does **not** contain the access token — it is httpOnly.
2. Reloading the page keeps you signed in, proving `/me` rehydration works.
3. Visiting `/login` while signed in does not break, and signing out returns you to `/login`.
4. `/dev/ping` still completes.

- [ ] **Step 5: Verify one session spans SPA and admin**

With the browser still signed in at `:5174`, open `http://localhost:3010`.

Expected: already signed in, no second login. This confirms the per-host cookie behaviour the Global Constraints describe. Record the result either way — if it does *not* hold, the constraint is wrong and the README must be corrected.

- [ ] **Step 6: Add the admin build to CI**

Add a third job to `.github/workflows/ci.yml`. It must clone core at the pinned ref first, exactly as the plugin job does, because the admin source lives inside it:

```yaml
  admin:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Fetch pinned whity-core (the admin source lives here)
        run: |
          git clone https://github.com/AmroKSaleh/whity-core.git host/.core
          git -C host/.core checkout "$(cat host/core.version)"

      - uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Install
        working-directory: host/.core/web
        run: npm ci --no-audit --no-fund

      - name: Build
        working-directory: host/.core/web
        run: npm run build
```

This catches a core upgrade that breaks the admin build before it reaches a machine.

- [ ] **Step 7: Update the README's foundation checks**

Add to that list:

```markdown
- `http://localhost:3010` — whity's admin UI; one login is shared with the SPA
- `http://localhost:5174/login` — password login, 2FA challenge, tenant selection
```

- [ ] **Step 8: Commit**

```bash
git add app/src README.md .github/workflows/ci.yml
git commit -m "feat: retire Supabase auth in favour of whity identity"
```

---

## Acceptance

P1 is complete when:

1. `npm run host:up` brings up Postgres, FrankenPHP **and** the admin; `/api/health` returns 200 and `:3010` serves the admin.
2. A user signs in at `:5174/login` with password, is challenged for 2FA when enabled, and picks a workspace when they hold more than one membership.
3. The session survives a page reload, an expired access token (refreshed transparently), and sign-out.
4. One login is shared between the SPA and the admin.
5. No Supabase import remains in any authentication path; `OAuthAuthorizePage.jsx` is gone.
6. `npm run app:test`, `npm run plugin:test` and `npm run plugin:stan` are green; CI has three jobs and passes.
7. `/dev/ping` still completes at both `:5174` and `:8010`.

**Not in scope, by design:** the board still reads Supabase and does not work. That is D1 and D2.
