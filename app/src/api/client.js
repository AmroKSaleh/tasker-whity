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

  // 204 No Content carries no body by definition (every DELETE returns this)
  // — calling .json() on it throws `SyntaxError: Unexpected end of JSON
  // input` rather than returning anything useful, so short-circuit before
  // ever attempting to parse one.
  if (response.status === 204) {
    return null
  }

  // Any other empty-bodied response (e.g. a 200 with no content) fails
  // .json() the same way; treat that parse failure as "no body" too, rather
  // than letting a SyntaxError escape as if it were a network/programming
  // error. This mirrors the same-file precedent of swallowing a non-JSON
  // body above.
  try {
    return await response.json()
  } catch (err) {
    if (err instanceof SyntaxError) {
      return null
    }
    throw err
  }
}
