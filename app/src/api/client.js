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

/**
 * Perform an API request.
 *
 * @param {string} path Absolute API path, e.g. '/api/v1/tasker/pings'.
 * @param {{ method?: string, body?: unknown, headers?: Record<string,string> }} [options]
 * @returns {Promise<any>} The parsed JSON response body.
 * @throws {ApiError} When the response status is not ok.
 */
export async function apiFetch(path, options = {}) {
  const { method = 'GET', body, headers = {} } = options

  const init = {
    method,
    credentials: 'include',
    headers: {
      // Caller-supplied headers first, then the mandated header last, so it
      // always wins even if a caller passes its own X-Requested-With (or a
      // differently-cased variant). Required by the host's CsrfGuard on
      // every mutating request; harmless on reads, so it is unconditional
      // rather than a per-call decision — and non-negotiable by callers.
      ...headers,
      'X-Requested-With': 'XMLHttpRequest',
    },
  }

  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(body)
  }

  const response = await fetch(path, init)

  if (!response.ok) {
    let message = `Request failed with status ${response.status}`
    try {
      const payload = await response.json()
      if (payload && typeof payload.error === 'string') {
        message = payload.error
      } else if (payload && typeof payload.message === 'string') {
        message = payload.message
      }
    } catch {
      // Non-JSON error body — keep the generic message.
    }
    throw new ApiError(response.status, message)
  }

  return response.json()
}
