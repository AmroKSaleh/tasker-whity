export default function InProgressSidebar({ tasks, onRemove, onDone, onFocus }) {
  const inProgress = tasks.filter(t => t.status === 'in_progress')
  const [featured, ...rest] = inProgress

  if (inProgress.length === 0) {
    return (
      <p className="text-[12px] text-mute-2 text-center py-6">
        No tasks in progress
      </p>
    )
  }

  return (
    <>
      {/* Featured "doing now" card */}
      <div style={{
        position: 'relative',
        background: '#111', color: '#fff',
        borderRadius: 10, padding: '12px 14px',
        marginBottom: 10,
      }}>
        {/* Remove from in-progress — top right */}
        <button
          onClick={() => onRemove(featured)}
          title="Remove from in progress"
          style={{
            position: 'absolute', top: 8, right: 10,
            background: 'transparent', border: '1px solid #444',
            color: '#aaa', fontSize: 11, lineHeight: 1,
            padding: '3px 7px', borderRadius: 4, cursor: 'pointer',
            transition: 'border-color 0.15s, color 0.15s',
            fontFamily: 'inherit',
          }}
          onMouseEnter={e => { e.currentTarget.style.borderColor = '#888'; e.currentTarget.style.color = '#fff' }}
          onMouseLeave={e => { e.currentTarget.style.borderColor = '#444'; e.currentTarget.style.color = '#aaa' }}
        >◀</button>

        {/* Section label */}
        <div className="font-mono text-[9px] tracking-widest mb-2 pr-6" style={{ color: '#777' }}>
          {featured.sectionName ? featured.sectionName.toUpperCase() : 'IN PROGRESS'}
        </div>

        <div className="text-[13px] font-bold leading-snug mb-3 pr-2">
          {featured.text}
        </div>

        {/* Focus + Mark done — equal width */}
        <div style={{ display: 'flex', gap: 8 }}>
          {onFocus && (
            <button
              onClick={() => onFocus(featured.id)}
              className="btn-focus"
              style={{ flex: 1, padding: '6px 0', justifyContent: 'center', fontSize: 11 }}
            >Focus</button>
          )}
          {onDone && (
            <button
              onClick={() => onDone(featured)}
              style={{
                flex: 1, padding: '6px 0',
                background: '#fff', color: '#111',
                border: 'none', borderRadius: 5,
                fontSize: 11, fontWeight: 700, cursor: 'pointer',
              }}
            >Mark done</button>
          )}
        </div>
      </div>

      {/* Secondary in-progress tasks */}
      {rest.map(task => (
        <div
          key={task.id}
          style={{
            position: 'relative',
            border: '1px dashed #cfcfcf', borderRadius: 8,
            padding: '10px 12px', background: '#fff', marginBottom: 8,
          }}
        >
          {/* Remove button — top right */}
          <button
            onClick={() => onRemove(task)}
            title="Remove from in progress"
            style={{
              position: 'absolute', top: 6, right: 8,
              background: 'transparent', border: '1px solid var(--color-line)',
              color: 'var(--color-mute-2)', fontSize: 11, lineHeight: 1,
              padding: '3px 7px', borderRadius: 4, cursor: 'pointer',
              transition: 'border-color 0.15s, color 0.15s',
              fontFamily: 'inherit',
            }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--color-ink)'; e.currentTarget.style.color = 'var(--color-ink)' }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--color-line)'; e.currentTarget.style.color = 'var(--color-mute-2)' }}
          >◀</button>

          <div className="flex items-start gap-2 pr-5">
            <div
              style={{
                width: 12, height: 12, borderRadius: 2,
                border: '1.25px solid #111',
                backgroundImage: 'repeating-linear-gradient(45deg, #000 0 1.5px, #fff 1.5px 3px)',
                flexShrink: 0, marginTop: 1,
              }}
            />
            <span className="text-[12px] font-semibold text-ink flex-1 min-w-0 leading-snug">
              {task.text}
            </span>
          </div>

          {task.sectionName && (
            <div className="font-mono text-[9px] text-mute mt-1.5 tracking-wide">
              {task.sectionName.toUpperCase()}
            </div>
          )}
        </div>
      ))}
    </>
  )
}
