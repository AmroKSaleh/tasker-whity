import { apiFetch } from './client'

/**
 * Interpret whity's login-family response as one of four outcomes.
 *
 * The server answers a login attempt in one of four ways (see
 * host/.core/src/Auth/AuthHandler.php): a 202 carrying requires_2fa, a 202
 * carrying requires_2fa_enrollment (an admin-mandated 2FA policy the caller
 * hasn't enrolled in yet — enrollment itself happens in whity's admin UI,
 * out of scope here), a 200 carrying requires_tenant_selection plus the
 * caller's memberships, or a 200 meaning the session is established. 2FA
 * completion can itself require tenant selection (or hit the enrollment
 * gate), so all three entry points (login, completeTwoFactor, selectTenant)
 * share this interpreter.
 *
 * @param {any} payload
 * @returns {{status: 'authenticated'|'requires_2fa'|'requires_2fa_enrollment'|'requires_tenant_selection', memberships?: Array<{tenant_id:number,tenant_name:string,role:string}>, user?: any}}
 */
function interpret(payload) {
  if (payload?.requires_2fa) {
    return { status: 'requires_2fa' }
  }
  if (payload?.requires_2fa_enrollment) {
    return { status: 'requires_2fa_enrollment' }
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
