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
})
