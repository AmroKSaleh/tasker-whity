import { useState, useRef } from 'react'

export default function AddTaskInput({ onAdd, placeholder = 'Add task…' }) {
  const [text, setText] = useState('')
  const [focused, setFocused] = useState(false)
  const inputRef = useRef(null)

  async function handleSubmit(e) {
    e.preventDefault()
    const trimmed = text.trim()
    if (!trimmed) return
    await onAdd(trimmed)
    setText('')
    inputRef.current?.focus()
  }

  return (
    <form
      onSubmit={handleSubmit}
      className={`
        flex items-center gap-2 px-5 py-2.5
        border-t border-outline-variant
        transition-colors duration-150
        ${focused ? 'bg-surface-container-low' : ''}
      `}
    >
      <span className="text-on-surface-variant text-sm shrink-0">+</span>
      <input
        ref={inputRef}
        value={text}
        onChange={e => setText(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        placeholder={placeholder}
        className="flex-1 bg-transparent outline-none text-body-medium text-on-surface placeholder:text-on-surface-variant py-1"
      />
      {text.trim() && (
        <button
          type="submit"
          className="shrink-0 text-label-small text-primary hover:opacity-70 transition-opacity"
        >
          Add
        </button>
      )}
    </form>
  )
}
