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

  it('reports requires_2fa_enrollment on a 202 mandatory-enrollment refusal', async () => {
    // See host/.core/src/Auth/AuthHandler.php's twoFactorPolicyRefusal():
    // an admin-mandated 2FA policy whose grace period has expired refuses
    // the login with this shape instead of establishing a session. Without
    // recognizing it, interpret() falls through to the 'authenticated'
    // branch with user: null, which silently bounces the caller back to
    // /login (LoginPage.applyOutcome calls refresh() -> getMe() 401s).
    stubJson(202, {
      requires_2fa_enrollment: true,
      enrollment_token: 'header.payload.sig',
      enrollment_deadline: 1234567890,
    })

    const result = await login('a@b.c', 'pw')

    expect(result).toEqual({ status: 'requires_2fa_enrollment' })
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

  it('can also hit the mandatory-enrollment gate, via the same shared interpreter', async () => {
    // Proves the fix in interpret() covers this entry point too, without
    // any change to completeTwoFactor itself — all three login-family
    // functions funnel through interpret().
    stubJson(202, { requires_2fa_enrollment: true })

    expect((await completeTwoFactor('123456')).status).toBe('requires_2fa_enrollment')
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
