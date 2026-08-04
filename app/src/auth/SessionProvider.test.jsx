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
