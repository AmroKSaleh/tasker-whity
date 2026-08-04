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

  it('shows the enrollment-required message instead of silently redirecting when the server mandates 2FA enrollment', async () => {
    login.mockResolvedValue({ status: 'requires_2fa_enrollment' })
    setup()
    await submitCredentials()

    // Before Fix 4, this outcome fell through to the 'authenticated' branch,
    // calling refresh() (which the test would observe here) and navigating
    // away with no explanation. It must NOT do that, and must instead show
    // a clear message with a link to the admin portal.
    await waitFor(() => expect(screen.getByRole('heading', { name: /two-factor authentication required/i })).toBeTruthy())
    expect(screen.getByText(/organization requires two-factor authentication/i)).toBeTruthy()
    expect(screen.getByRole('link', { name: /admin portal/i }).getAttribute('href')).toBe('http://localhost:3010/login')
    expect(refresh).not.toHaveBeenCalled()
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
