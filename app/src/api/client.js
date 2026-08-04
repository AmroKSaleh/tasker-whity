/**
 * Same-origin API client for the whity host.
 *
 * In dev, Vite proxies /api to the host, so requests are same-origin in both
 * environments and the SameSite=Lax session cookie is sent automatically.
 * Nothing here ever touches a token: the JWT lives in an httpOnly cookie the
 * browser handles for us.
 *
 * Two host contract details are baked in here rather than left to callers:
 * every request carries X-Requested-With, because the host's CsrfGuard 403s
 * mutating requests without it; and callers pass versioned paths
 * (/api/v1/...), because the router injects /v1 into everything except
 * /api/health, /api/version, /api/openapi.json and /mcp.
 */

export class ApiError extends Error {
  constructor(status, message) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

const REFRESH_PATH = '/api/v1/auth/refresh'

let unauthorizedHandler = null

// Shared in-flight refresh, so N concurrent callers that all 401 at once
// (e.g. a page firing several parallel resource fetches right as the access
// token expires) issue exactly one POST /api/v1/auth/refresh between them
// rather than one each. The assignment below happens synchronously — before
// any `await` — so every caller that calls refreshSession() before the
// in-flight one settles observes the same non-null promise instead of racing
// to start its own. Cleared in .finally() so the NEXT real 401 (a later,
// unrelated expiry) starts a fresh refresh rather than reusing a stale one.
let refreshPromise = null

/**
 * Register a callback invoked when a 401 could not be recovered by refreshing.
 * The app uses this to clear session state and route to login.
 *
 * @param {(() => void) | null} fn
 */
export function setUnauthorizedHandler(fn) {
  unauthorizedHandler = fn
}

/**
 * Start (or join) the single in-flight session refresh.
 *
 * @returns {Promise<Response>}
 */
function refreshSession() {
  if (!refreshPromise) {
    refreshPromise = sendRequest(REFRESH_PATH, { method: 'POST' }).finally(() => {
      refreshPromise = null
    })
  }
  return refreshPromise
}

/**
 * Perform an API request.
 *
 * @param {string} path Absolute API path, e.g. '/api/v1/tasker/pings'.
 * @param {{ method?: string, body?: unknown, headers?: Record<string,string> }} [options]
 * @returns {Promise<any>} The parsed JSON response body.
 * @throws {ApiError} When the response status is not ok, or when an
 *   otherwise-ok non-204 response's body cannot be parsed as JSON.
 */
export async function apiFetch(path, options = {}) {
  let response = await sendRequest(path, options)

  // A 401 on anything except the refresh endpoint itself gets one recovery
  // attempt. Refreshing the refresh call would recurse.
  if (response.status === 401 && path !== REFRESH_PATH) {
    const refreshed = await refreshSession()
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

  try {
    return await response.json()
  } catch (err) {
    // The response was ok (2xx) but had no body, or a body that isn't valid
    // JSON. That is still a real failure — this deliberately does not widen
    // the 204-only null-return carve-out above — but it must surface as an
    // ApiError, not a bare SyntaxError, so every apiFetch failure carries the
    // same `.status` shape for callers' catch blocks. There's no HTTP status
    // for "the body didn't parse", so the response's own (successful) status
    // is attached: it's the closest available answer to "what request was
    // this", not a claim that this status code implies a parse failure.
    throw new ApiError(response.status, `Response body could not be parsed as JSON: ${err.message}`)
  }
}

/**
 * Issue one request with the mandated headers. No 401 handling here.
 *
 * @param {string} path
 * @param {{ method?: string, body?: unknown, headers?: Record<string,string> }} options
 * @returns {Promise<Response>}
 */
async function sendRequest(path, options = {}) {
  const { method = 'GET', body, headers = {} } = options

  // HTTP header names are case-insensitive, but a plain-object spread is not:
  // {'x-requested-with': ..., 'X-Requested-With': ...} would survive as two
  // distinct properties, and the Fetch spec's Headers normalisation COMBINES
  // same-name headers with a comma rather than letting either win outright
  // (verified: new Headers({'x-requested-with':'evil','X-Requested-With':'XMLHttpRequest'})
  // produces a single header whose value is "evil, XMLHttpRequest"). So any
  // caller-supplied key that case-insensitively matches x-requested-with is
  // dropped here, before the mandated header is applied, rather than relying
  // on later-key-wins semantics that only hold for exact-case duplicates in
  // a plain object.
  const callerHeaders = Object.fromEntries(
    Object.entries(headers).filter(([key]) => key.toLowerCase() !== 'x-requested-with'),
  )

  const init = {
    method,
    credentials: 'include',
    headers: {
      // Caller-supplied headers first, then the mandated header last, so it
      // always wins — regardless of casing, since same-case-insensitive
      // keys were already stripped above. Required by the host's CsrfGuard
      // on every mutating request; harmless on reads, so it is unconditional
      // rather than a per-call decision — and non-negotiable by callers.
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
