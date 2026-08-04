import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import SettingsPage from './SettingsPage'

// SettingsPage pulls in a lot of unrelated surface area (AppShell's nav,
// connector/webhook/instruction sections, the theme hook). None of that is
// under test here — Fix 1 is specifically about where the Account row's
// email comes from — so everything except useSession is stubbed out to keep
// this test from depending on Supabase, localStorage-backed settings, or
// other pages' data hooks.
const signOut = vi.fn()
let sessionUser = { id: 1, email: 'person@example.com' }
vi.mock('../auth/SessionProvider', () => ({
  useSession: () => ({ user: sessionUser, signOut }),
}))

vi.mock('../lib/supabase', () => ({
  supabase: {
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null } }) },
    from: vi.fn(() => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }),
      upsert: vi.fn(),
      insert: vi.fn(),
      delete: () => ({ eq: vi.fn() }),
    })),
  },
}))

vi.mock('../hooks/useTheme', () => ({
  useTheme: () => ({ preference: 'system', setPreference: vi.fn(), resolved: 'light' }),
}))

vi.mock('../components/editorial/AppShell', () => ({
  default: ({ children }) => <div>{children}</div>,
}))
vi.mock('../components/settings/TaskStatusSettings', () => ({ default: () => null }))
vi.mock('../components/settings/ConnectorsSection', () => ({ default: () => null }))
vi.mock('../components/settings/WebhooksSection', () => ({ default: () => null }))
vi.mock('../components/settings/DefaultInstructionsSection', () => ({ default: () => null }))

function setup() {
  return render(<MemoryRouter><SettingsPage /></MemoryRouter>)
}

describe('SettingsPage Account row', () => {
  it("renders the signed-in user's email from useSession(), not a Supabase call", async () => {
    setup()

    // If this were still reading a `userEmail` state variable populated by a
    // dead `supabase.auth.getUser()` call (which the mock above resolves to
    // `{ user: null }`), the row would render empty text instead of the
    // email below — this assertion fails without the Fix 1 change.
    expect(await screen.findByText('person@example.com')).toBeTruthy()
  })

  it('renders nothing for the email when useSession has no user yet', async () => {
    sessionUser = null
    setup()

    // No crash, and no stray email text — the account row should just show
    // an empty span rather than throwing on `user.email`.
    expect(screen.queryByText('person@example.com')).toBeNull()
    sessionUser = { id: 1, email: 'person@example.com' }
  })
})
