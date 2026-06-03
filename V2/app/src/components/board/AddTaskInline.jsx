import { useState, useRef, useEffect } from 'react'

export default function AddTaskInline({ label = 'Add task', sectionId, groupId = null, onAdd, onAddDetailed }) {
  const [active, setActive] = useState(false)
  const [value, setValue] = useState('')
  const inputRef = useRef(null)

  useEffect(() => {
    if (active && inputRef.current) {
      inputRef.current.focus()
      autoResize(inputRef.current)
    }
  }, [active])

  function autoResize(el) {
    el.style.height = 'auto'
    el.style.height = el.scrollHeight + 'px'
  }

  function handleChange(e) {
    setValue(e.target.value)
    autoResize(e.target)
  }

  function commit(detailed = false) {
    const v = value.trim()
    if (v) {
      if (detailed && onAddDetailed) onAddDetailed(sectionId, v, groupId)
      else if (onAdd) onAdd(sectionId, v, groupId)
    }
    setValue('')
    setActive(false)
  }

  if (!active) {
    return (
      <button
        type="button"
        onClick={() => setActive(true)}
        className="mx-0.5 my-1 flex items-center gap-2 rounded-md border border-dashed border-line bg-transparent px-2.5 py-2 text-left font-sans text-xs text-mute transition-colors hover:border-mute-2 hover:bg-surf-2 hover:text-ink-2 w-full"
      >
        <span className="font-mono text-[13px] text-mute-2">+</span>
        {label}
      </button>
    )
  }

  return (
    <textarea
      ref={inputRef}
      value={value}
      rows={1}
      onChange={handleChange}
      onKeyDown={e => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && onAddDetailed) { e.preventDefault(); commit(true) }
        else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commit(false) }
        if (e.key === 'Escape') { setValue(''); setActive(false) }
      }}
      onBlur={() => commit(false)}
      placeholder={onAddDetailed ? 'Task title…  ⌘↵ for details' : 'Task title…'}
      className="mx-0.5 my-1 w-full rounded-md border border-accent bg-paper px-2.5 py-2 font-sans text-xs text-ink outline-none placeholder:text-mute-2 leading-snug"
      style={{ resize: 'none', overflow: 'hidden' }}
    />
  )
}
