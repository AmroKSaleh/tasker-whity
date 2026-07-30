import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { previewInvitation, acceptInvitation } from '../lib/invitations'

const PENDING_KEY = 'tasker.pendingInvite'

// Public org-invitation accept page (TDE-361), reachable logged-out. Shows which org the invite is
// for, then: if signed in → accept immediately; if not → stash the token and send to login (the
// same token stays valid after signup, so "not on Tasker yet" works identically). AuthGuard also
// checks PENDING_KEY after any login (incl. OAuth, which redirects to /dashboard) and routes back.
export default function InvitePage() {
  const { token } = useParams()
  const navigate = useNavigate()
  const [invite, setInvite] = useState(null)
  const [session, setSession] = useState(undefined)
  const [status, setStatus] = useState('loading') // loading | ready | accepting | done | error
  const [err, setErr] = useState('')

  useEffect(() => {
    async function load() {
      const { data: { session } } = await supabase.auth.getSession()
      setSession(session)
      if (session) localStorage.removeItem(PENDING_KEY)
      try {
        const inv = await previewInvitation(token)
        if (!inv) { setErr('This invitation could not be found.'); setStatus('error'); return }
        if (inv.status === 'accepted') { setErr('This invitation has already been accepted.'); setStatus('error'); return }
        if (inv.status === 'revoked') { setErr('This invitation has been revoked.'); setStatus('error'); return }
        if (inv.expired) { setErr('This invitation has expired.'); setStatus('error'); return }
        setInvite(inv); setStatus('ready')
      } catch (e) { setErr(e.message); setStatus('error') }
    }
    load()
  }, [token])

  async function handleAccept() {
    if (!session) {
      localStorage.setItem(PENDING_KEY, token)
      navigate(`/login?next=/invite/${token}`)
      return
    }
    setStatus('accepting'); setErr('')
    try {
      await acceptInvitation(token)
      localStorage.removeItem(PENDING_KEY)
      setStatus('done')
      setTimeout(() => navigate('/organizations', { replace: true }), 1400)
    } catch (e) { setErr(e.message); setStatus('ready') }
  }

  return (
    <div className="min-h-screen bg-paper flex flex-col items-center justify-center p-6">
      <div className="mb-8 text-center">
        <div className="inline-flex items-center gap-2 mb-2">
          <span style={{ color: '#D97757', fontSize: 18, fontWeight: 700 }}>✦</span>
          <h1 className="text-[24px] font-extrabold text-ink tracking-tight">Tasker</h1>
        </div>
      </div>

      <div className="w-full max-w-sm bg-paper border border-line rounded-xl shadow-card p-7 text-center">
        {status === 'loading' && <p className="text-[13px] text-mute">Loading invitation…</p>}

        {status === 'error' && (
          <>
            <p className="text-[15px] font-semibold text-ink mb-2">Invitation unavailable</p>
            <p className="text-[13px] text-mute mb-5">{err}</p>
            <button onClick={() => navigate('/home')} className="btn btn-sm">Go to Tasker</button>
          </>
        )}

        {status === 'done' && (
          <>
            <p className="text-[32px] mb-2">✦</p>
            <p className="text-[15px] font-semibold text-ink mb-1">You're in.</p>
            <p className="text-[13px] text-mute">Welcome to {invite?.org_name}. Taking you there…</p>
          </>
        )}

        {(status === 'ready' || status === 'accepting') && (
          <>
            <p className="font-mono text-[9px] uppercase tracking-widest text-mute-2 mb-2">Invitation</p>
            <p className="text-[16px] text-ink mb-1">
              Join <span className="font-semibold">{invite.org_name}</span>
            </p>
            <p className="text-[13px] text-mute mb-5">
              You've been invited as {invite.role === 'admin' ? 'an admin' : 'a member'}.
              {!session && ' Sign in or create an account to accept.'}
            </p>
            {err && <p className="text-[12px] text-red-500 mb-3">{err}</p>}
            <button
              onClick={handleAccept}
              disabled={status === 'accepting'}
              className="w-full h-10 bg-ink text-paper rounded-md text-[13px] font-semibold tracking-tight transition-all duration-150 hover:bg-ink-2 disabled:opacity-40 disabled:pointer-events-none"
            >
              {status === 'accepting' ? 'Joining…' : session ? 'Accept invitation' : 'Sign in to accept'}
            </button>
          </>
        )}
      </div>
    </div>
  )
}
