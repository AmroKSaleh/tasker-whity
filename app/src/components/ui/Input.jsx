import { useId } from 'react'

export default function Input({
  label,
  value,
  onChange,
  type = 'text',
  error,
  className = '',
  ...props
}) {
  const id = useId()

  return (
    <div className={`flex flex-col gap-1 ${className}`}>
      {label && (
        <label htmlFor={id} className="text-[11px] font-semibold text-mute uppercase tracking-wider">
          {label}
        </label>
      )}
      <input
        id={id}
        type={type}
        value={value}
        onChange={onChange}
        className={`
          w-full bg-surf-2 rounded-md px-3 py-2.5
          text-[13px] text-ink font-medium
          border outline-none
          transition-colors duration-150
          placeholder:text-mute-2
          ${error
            ? 'border-red-400 focus:border-red-500'
            : 'border-line focus:border-ink'
          }
        `}
        {...props}
      />
      {error && (
        <p className="text-[11px] text-red-500">{error}</p>
      )}
    </div>
  )
}
