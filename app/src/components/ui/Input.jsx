import { useState, useId } from 'react'

export default function Input({
  label,
  value,
  onChange,
  type = 'text',
  error,
  helperText,
  className = '',
  inputRef,
  ...props
}) {
  const [focused, setFocused] = useState(false)
  const id = useId()
  const hasValue = value !== undefined ? value !== '' : false
  const floated = focused || hasValue

  return (
    <div className={`relative ${className}`}>
      <div
        className={`
          relative flex items-end
          bg-surface-container-high rounded-t-sm
          border-b-2 transition-colors duration-200
          ${focused ? 'border-primary' : error ? 'border-error' : 'border-on-surface-variant'}
        `}
      >
        {label && (
          <label
            htmlFor={id}
            className={`
              absolute left-4 pointer-events-none select-none
              transition-all duration-200 origin-top-left
              ${floated
                ? 'top-2 text-label-medium text-primary scale-75 -translate-x-[6px]'
                : 'top-1/2 -translate-y-1/2 text-body-large text-on-surface-variant'
              }
              ${error ? '!text-error' : ''}
            `}
          >
            {label}
          </label>
        )}
        <input
          id={id}
          ref={inputRef}
          type={type}
          value={value}
          onChange={onChange}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          className={`
            w-full bg-transparent outline-none
            px-4 pb-2 text-body-large text-on-surface
            ${label ? 'pt-6' : 'pt-2'}
            placeholder:text-on-surface-variant
          `}
          {...props}
        />
      </div>
      {(error || helperText) && (
        <p className={`mt-1 px-4 text-body-small ${error ? 'text-error' : 'text-on-surface-variant'}`}>
          {error || helperText}
        </p>
      )}
    </div>
  )
}
