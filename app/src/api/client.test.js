import { describe, it, expect, vi, afterEach } from 'vitest'
import { apiFetch, ApiError, setUnauthorizedHandler } from './client'

afterEach(() => {
  vi.unstubAllGlobals()
})

function stubFetch(response) {
  const fetchMock = vi.fn().mockResolvedValue(response)
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('apiFetch', () => {
  it('sends cookies and returns the parsed body', async () => {
    const fetchMock = stubFetch({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: 1 }] }),
    })

    const result = await apiFetch('/api/v1/tasker/pings')

    expect(result).toEqual({ data: [{ id: 1 }] })
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/tasker/pings',
      expect.objectContaining({ credentials: 'include' }),
    )
  })

  it('always sends the CSRF header the host requires', async () => {
    const fetchMock = stubFetch({ ok: true, status: 200, json: async () => ({ data: [] }) })

    await apiFetch('/api/v1/tasker/pings')

    const [, options] = fetchMock.mock.calls[0]
    expect(options.headers['X-Requested-With']).toBe('XMLHttpRequest')
  })

  it('throws ApiError carrying the status and server message', async () => {
    stubFetch({
      ok: false,
      status: 403,
      json: async () => ({ error: 'Tenant context is required' }),
    })

    await expect(apiFetch('/api/v1/tasker/pings')).rejects.toMatchObject({
      status: 403,
      message: 'Tenant context is required',
    })
  })

  it('throws ApiError even when the error body is not JSON', async () => {
    stubFetch({
      ok: false,
      status: 500,
      json: async () => {
        throw new Error('not json')
      },
    })

    const error = await apiFetch('/api/v1/tasker/pings').catch((e) => e)

    expect(error).toBeInstanceOf(ApiError)
    expect(error.status).toBe(500)
  })

  it('serialises a JSON body and sets the content type', async () => {
    const fetchMock = stubFetch({ ok: true, status: 201, json: async () => ({ data: {} }) })

    await apiFetch('/api/v1/tasker/pings', { method: 'POST', body: { label: 'x' } })

    const [, options] = fetchMock.mock.calls[0]
    expect(options.body).toBe('{"label":"x"}')
    expect(options.headers['Content-Type']).toBe('application/json')
  })

  it('does not let a caller override the mandated CSRF header', async () => {
    const fetchMock = stubFetch({ ok: true, status: 200, json: async () => ({ data: [] }) })

    await apiFetch('/api/v1/tasker/pings', {
      headers: { 'X-Requested-With': 'not-the-real-value' },
    })

    const [, options] = fetchMock.mock.calls[0]
    expect(options.headers['X-Requested-With']).toBe('XMLHttpRequest')
  })

  it('returns null for a 204 No Content response instead of throwing', async () => {
    stubFetch({
      ok: true,
      status: 204,
      json: async () => {
        // Real fetch's Response.json() throws exactly this on an empty body
        // (e.g. every DELETE, per Plan C) — the mock reproduces that so the
        // test actually exercises apiFetch's guard rather than a mock that
        // just happens not to call .json().
        throw new SyntaxError('Unexpected end of JSON input')
      },
    })

    const result = await apiFetch('/api/v1/tasker/pings/1', { method: 'DELETE' })

    expect(result).toBeNull()
  })

  it('does not let a differently-cased caller header pollute the real outgoing header', async () => {
    const fetchMock = stubFetch({ ok: true, status: 200, json: async () => ({ data: [] }) })

    await apiFetch('/api/v1/tasker/pings', {
      headers: { 'x-requested-with': 'evil-value' },
    })

    const [, options] = fetchMock.mock.calls[0]
    // A plain-object assertion cannot catch this: HTTP header names are
    // case-insensitive, but {'x-requested-with': ..., 'X-Requested-With': ...}
    // survive as two distinct properties on a JS object. The real Fetch
    // algorithm normalises through a Headers instance, which COMBINES
    // same-name (case-insensitively) headers with a comma rather than
    // letting either one win — so we build the actual Headers the browser's
    // fetch would build from this init, and assert on that.
    const normalized = new Headers(options.headers)
    expect(normalized.get('x-requested-with')).toBe('XMLHttpRequest')
    expect([...normalized.entries()]).toEqual([['x-requested-with', 'XMLHttpRequest']])
  })
})

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

    // Fix 3: this must still throw (the 204-only null carve-out is
    // unchanged) but now as an ApiError carrying .status, not a bare
    // SyntaxError — see the next test for the shape assertion.
    await expect(apiFetch('/api/v1/me')).rejects.toThrow(ApiError)
  })

  it('wraps a 200 response whose body fails to parse in an ApiError with .status set', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => { throw new SyntaxError('Unexpected end of JSON input') },
    })))

    const error = await apiFetch('/api/v1/me').catch((e) => e)

    // Before Fix 3 this was a bare SyntaxError with no .status, which is a
    // different shape from every other apiFetch failure (ApiError). Any
    // `catch (e) { setError(e.status ? ... : ...) }`-style caller needs one
    // consistent shape regardless of whether the failure was an HTTP error
    // or an unparseable-but-2xx body.
    expect(error).toBeInstanceOf(ApiError)
    expect(error).not.toBeInstanceOf(SyntaxError)
    expect(error.status).toBe(200)
    expect(error.message).toMatch(/could not be parsed as JSON/i)
  })

  it('wraps a 201 response whose body fails to parse using that response\'s own status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 201,
      json: async () => { throw new SyntaxError('Unexpected token') },
    })))

    const error = await apiFetch('/api/v1/tasker/pings', { method: 'POST', body: {} }).catch((e) => e)

    expect(error).toBeInstanceOf(ApiError)
    expect(error.status).toBe(201)
  })
})

describe('apiFetch concurrent refresh deduplication', () => {
  it('shares a single in-flight refresh across concurrent 401s and still retries every caller', async () => {
    // Three distinct resource paths each 401 on their FIRST request, then
    // succeed once retried after a refresh. Without Fix 2, each of the three
    // concurrent 401s would independently POST /api/v1/auth/refresh — three
    // refresh calls instead of one.
    const paths = ['/api/v1/a', '/api/v1/b', '/api/v1/c']
    const firstAttemptDone = Object.fromEntries(paths.map((p) => [p, false]))
    let refreshCalls = 0

    const fetchMock = vi.fn(async (path) => {
      if (path === '/api/v1/auth/refresh') {
        refreshCalls += 1
        return { ok: true, status: 200, json: async () => ({ data: {} }) }
      }
      if (!firstAttemptDone[path]) {
        firstAttemptDone[path] = true
        return { ok: false, status: 401, json: async () => ({ error: 'Unauthorized' }) }
      }
      return { ok: true, status: 200, json: async () => ({ data: { path } }) }
    })
    vi.stubGlobal('fetch', fetchMock)

    const results = await Promise.all(paths.map((p) => apiFetch(p)))

    expect(results).toEqual(paths.map((p) => ({ data: { path: p } })))
    expect(refreshCalls).toBe(1)
    expect(fetchMock.mock.calls.filter(([p]) => p === '/api/v1/auth/refresh')).toHaveLength(1)
    // Every original request was retried after the single shared refresh.
    paths.forEach((p) => {
      expect(fetchMock.mock.calls.filter(([called]) => called === p)).toHaveLength(2)
    })
  })

  it('starts a fresh refresh for a later, unrelated 401 after the first one settled', async () => {
    let refreshCalls = 0
    let phase = 1
    const fetchMock = vi.fn(async (path) => {
      if (path === '/api/v1/auth/refresh') {
        refreshCalls += 1
        return { ok: true, status: 200, json: async () => ({ data: {} }) }
      }
      if (phase === 1) {
        phase = 2
        return { ok: false, status: 401, json: async () => ({ error: 'Unauthorized' }) }
      }
      return { ok: true, status: 200, json: async () => ({ data: {} }) }
    })
    vi.stubGlobal('fetch', fetchMock)

    await apiFetch('/api/v1/x')
    // A second, later 401 (simulating a subsequent token expiry) must start
    // its own refresh rather than reusing the cleared, already-settled one.
    phase = 1
    await apiFetch('/api/v1/x')

    expect(refreshCalls).toBe(2)
  })
})
