export default function InProgressSidebar({ tasks, onRemove, onDone }) {
  const inProgress = tasks.filter(t => t.in_progress && !t.done)
  const [featured, ...rest] = inProgress

  return (
    <div>
      <div className="font-mono text-[9.5px] font-bold tracking-widest text-mute uppercase mb-3" style={{ letterSpacing: '1px' }}>
        In Progress · {inProgress.length}
      </div>

      {inProgress.length === 0 ? (
        <p className="text-[12px] text-mute-2 text-center py-6">
          No tasks in progress
        </p>
      ) : (
        <>
          {/* Featured "doing now" card */}
          <div style={{ background: '#111', color: '#fff', borderRadius: 10, padding: '12px 14px', marginBottom: 10 }}>
            <div className="font-mono text-[9px] text-[#888] tracking-widest mb-2" style={{ letterSpacing: '0.8px' }}>
              ★ DOING NOW
            </div>
            <div className="text-[13px] font-bold leading-snug mb-1">{featured.text}</div>
            {(featured.project?.description || featured.project?.name) && (
              <div className="font-mono text-[9px] text-[#666] mt-1 tracking-wide">
                {(featured.project.description || featured.project.name).toUpperCase()}
              </div>
            )}
            <div className="flex gap-2 mt-3">
              {onDone && (
                <button
                  onClick={() => onDone(featured)}
                  style={{ flex: 1, padding: '6px 0', background: '#fff', color: '#111', borderRadius: 5, fontSize: 11, fontWeight: 700, border: 'none', cursor: 'pointer' }}
                >
                  Mark done
                </button>
              )}
              <button
                onClick={() => onRemove(featured)}
                onMouseEnter={e => { e.currentTarget.style.background = '#ef4444'; e.currentTarget.style.borderColor = '#ef4444'; e.currentTarget.style.color = '#fff' }}
                onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.borderColor = '#444'; e.currentTarget.style.color = '#aaa' }}
                style={{ padding: '6px 10px', border: '1px solid #444', color: '#aaa', background: 'transparent', borderRadius: 4, fontSize: 11, cursor: 'pointer', transition: 'background 0.15s, border-color 0.15s, color 0.15s', fontFamily: 'inherit' }}
              >
                ×
              </button>
            </div>
          </div>

          {/* Secondary in-progress tasks */}
          {rest.map(task => (
            <div
              key={task.id}
              style={{ border: '1px dashed #cfcfcf', borderRadius: 8, padding: '10px 12px', background: '#fff', marginBottom: 8 }}
            >
              <div className="flex items-start gap-2">
                <div
                  style={{
                    width: 12, height: 12, borderRadius: 2, border: '1.25px solid #111',
                    backgroundImage: 'repeating-linear-gradient(45deg, #000 0 1.5px, #fff 1.5px 3px)',
                    flexShrink: 0, marginTop: 1,
                  }}
                />
                <span className="text-[12px] font-semibold text-ink flex-1 min-w-0 leading-snug">{task.text}</span>
                <button
                  onClick={() => onRemove(task)}
                  className="btn-delete"
                >
                  ×
                </button>
              </div>
              {(task.project?.description || task.project?.name) && (
                <div className="font-mono text-[9px] text-mute mt-1.5 tracking-wide">
                  {(task.project.description || task.project.name).toUpperCase()}
                </div>
              )}
            </div>
          ))}
        </>
      )}
    </div>
  )
}
