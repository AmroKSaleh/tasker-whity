import { describe, it, expect, vi, afterEach } from 'vitest'
import { apiFetch, ApiError } from './client'

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
