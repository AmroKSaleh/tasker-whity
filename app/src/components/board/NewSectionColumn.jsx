import { useState, useRef, useEffect } from 'react'

export default function NewSectionColumn({ onCreate }) {
  const [active, setActive] = useState(false)
  const [value, setValue] = useState('')
  const inputRef = useRef(null)

  useEffect(() => { if (active) inputRef.current?.focus() }, [active])

  function commit() {
    const v = value.trim()
    if (v) onCreate?.(v)
    setValue('')
    setActive(false)
  }

  if (active) {
    return (
      <div className="flex h-full w-60 shrink-0 flex-col justify-center rounded-xl border border-accent bg-paper p-4">
        <input
          ref={inputRef}
          value={value}
          onChange={e => setValue(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') commit()
            if (e.key === 'Escape') { setValue(''); setActive(false) }
          }}
          onBlur={commit}
          placeholder="Section name…"
          className="w-full rounded-md border border-accent bg-paper px-2.5 py-2 font-sans text-sm text-ink outline-none placeholder:text-mute-2"
        />
      </div>
    )
  }

  return (
    <div className="flex h-full w-60 shrink-0 items-center justify-center rounded-xl border-[1.5px] border-dashed border-line bg-transparent">
      <button
        type="button"
        onClick={() => setActive(true)}
        className="flex flex-col items-center gap-2 p-6 text-mute transition-colors hover:text-ink-2"
      >
        <span className="font-mono text-2xl text-mute-2">+</span>
        <span className="text-sm">New section</span>
      </button>
    </div>
  )
}
