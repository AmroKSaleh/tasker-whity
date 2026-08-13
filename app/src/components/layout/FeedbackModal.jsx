import { useState } from 'react'

const ENDPOINT = 'https://formspree.io/f/mvzyabnw'

export default function FeedbackModal({ onClose }) {
  const [message, setMessage] = useState('')
  const [status, setStatus] = useState('idle') // idle | sending | sent | error

  async function handleSubmit(e) {
    e.preventDefault()
    if (!message.trim() || status === 'sending') return
    setStatus('sending')
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ message: message.trim() }),
      })
      if (!res.ok) throw new Error()
      setStatus('sent')
    } catch {
      setStatus('error')
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-40"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="bg-paper rounded-2xl w-full max-w-md mx-4 shadow-xl flex flex-col">
        <div className="flex items-center justify-between px-6 pt-6 pb-0">
          <p className="text-[15px] font-semibold text-ink">Send Feedback</p>
          <button onClick={onClose} className="text-mute hover:text-ink text-lg leading-none transition-colors">×</button>
        </div>

        {status === 'sent' ? (
          <div className="flex flex-col items-center gap-3 px-6 py-10 text-center">
            <p className="text-[28px]">✦</p>
            <p className="text-[15px] font-semibold text-ink">Thanks for the feedback!</p>
            <p className="text-[13px] text-mute">It's been sent.</p>
            <button onClick={onClose} className="mt-2 px-5 py-2 rounded-lg bg-ink text-paper text-[13px] font-medium">
              Close
            </button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="flex flex-col gap-4 px-6 pt-4 pb-6">
            <textarea
              autoFocus
              value={message}
              onChange={e => { setMessage(e.target.value); if (status === 'error') setStatus('idle') }}
              placeholder="What's on your mind?"
              rows={5}
              className="w-full bg-surf-2 border border-line rounded-xl px-4 py-3 text-[13px] text-ink outline-none focus:border-ink transition-colors resize-none placeholder:text-mute-2"
            />
            {status === 'error' && (
              <p className="text-[11px] text-red-500 -mt-2">Something went wrong. Try again.</p>
            )}
            <div className="flex gap-2 justify-end">
              <button type="button" onClick={onClose} className="px-4 py-2 text-[13px] text-mute hover:text-ink transition-colors">
                Cancel
              </button>
              <button
                type="submit"
                disabled={!message.trim() || status === 'sending'}
                className="px-4 py-2 rounded-lg bg-ink text-paper text-[13px] font-medium disabled:opacity-40"
              >
                {status === 'sending' ? 'Sending…' : 'Send'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}
