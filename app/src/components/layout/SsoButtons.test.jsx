import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import SsoButtons from './SsoButtons'

vi.mock('../../api/auth', () => ({
  getSsoProviders: vi.fn(),
  startSsoUrl: (id) => `/api/v1/auth/sso/${id}/start`,
}))

import { getSsoProviders } from '../../api/auth'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('SsoButtons', () => {
  it('renders nothing when no providers are configured', async () => {
    getSsoProviders.mockResolvedValue([])

    const { container } = render(<SsoButtons />)

    await waitFor(() => expect(getSsoProviders).toHaveBeenCalled())
    expect(container.querySelectorAll('a')).toHaveLength(0)
  })

  it('renders a start link per provider', async () => {
    getSsoProviders.mockResolvedValue([{ id: 'google', name: 'Google' }])

    render(<SsoButtons />)

    const link = await waitFor(() => screen.getByRole('link', { name: /Google/ }))
    expect(link.getAttribute('href')).toBe('/api/v1/auth/sso/google/start')
  })

  it('renders nothing when the providers call fails', async () => {
    getSsoProviders.mockRejectedValue(new Error('boom'))

    const { container } = render(<SsoButtons />)

    await waitFor(() => expect(getSsoProviders).toHaveBeenCalled())
    expect(container.querySelectorAll('a')).toHaveLength(0)
  })
})
