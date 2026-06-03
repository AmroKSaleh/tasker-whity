// Tasker Redesign — column + task row + filter bar + project header + sidebar + panel

// ────────── TASK ROW ──────────
function TaskRow({ task, state, onClick }) {
  // state: 'normal' | 'in-progress' | 'done' | 'selected' | 'dragging'
  const cls = ['task'];
  if (task.done || state === 'done') cls.push('done');
  if (task.inProgress || state === 'in-progress') cls.push('in-progress');
  if (state === 'selected') cls.push('selected');
  if (state === 'dragging') cls.push('dragging');
  return (
    <div className={cls.join(' ')} onClick={onClick}>
      <div className="grip"><Icon.grip /></div>
      <div className="check" />
      <div className={"play " + (task.inProgress ? 'active' : '')}>
        {task.inProgress ? <Icon.pause /> : <Icon.play />}
      </div>
      <div className="body">
        <div className="title">{task.title}</div>
        {(task.priority || task.due || (task.tags || []).length > 0) && (
          <div className="meta">
            {task.priority && task.priority !== 'none' && (
              <span className={"chip " + task.priority}>{task.priority}</span>
            )}
            {task.due && (
              <span className={"chip due " + (task.overdue ? 'overdue' : task.today ? 'today' : '')}>
                {task.due}
              </span>
            )}
            {(task.tags || []).map((t, i) => (
              <span key={i} className="chip tag">#{t}</span>
            ))}
          </div>
        )}
      </div>
      {state !== 'dragging' && (
        <div className="row-tools">
          <button className="icon-btn" title="Edit"><Icon.edit /></button>
          <button className="icon-btn" title="Delete"><Icon.trash /></button>
        </div>
      )}
    </div>
  );
}

// ────────── COLUMN ──────────
// section = { name, done, total }
// lanes = [{ name, tasks: [...] }] or null for ungrouped flat
// ungrouped = tasks at top before any lane
function Column({ section, ungrouped = [], lanes = [], state, selectedTaskId, empty }) {
  if (state === 'collapsed') {
    return (
      <div className="col collapsed">
        <div className="col-header">
          <div className="titleblock">
            <div className="col-name">{section.name}</div>
          </div>
          <div className="col-meta">
            <span className="count">{section.done}/{section.total}</span>
          </div>
        </div>
      </div>
    );
  }

  const pct = section.total ? Math.round((section.done / section.total) * 100) : 0;
  return (
    <div className="col">
      <div className="col-header">
        <div className="col-grip"><Icon.grip /></div>
        <div className="titleblock">
          <div className="col-name">{section.name}</div>
          <div className="col-meta">
            <span className="count">{section.done}/{section.total}</span>
            <div className="bar" style={{ flex: 1, maxWidth: 60 }}>
              <i style={{ width: pct + '%' }} />
            </div>
          </div>
        </div>
        <div className="col-tools">
          <button className="icon-btn" title="Collapse"><Icon.collapse /></button>
          <button className="icon-btn" title="More"><Icon.more /></button>
        </div>
      </div>

      {empty ? (
        <div className="col-empty">
          <div className="glyph"><Icon.plus /></div>
          <div className="msg">No tasks yet.<br/>Add a stage or task to start.</div>
        </div>
      ) : (
        <div className="col-body">
          {/* Ungrouped tasks at top — no label */}
          {ungrouped.map(t => (
            <TaskRow
              key={t.id}
              task={t}
              state={t.id === selectedTaskId ? 'selected' : (t.state || 'normal')}
            />
          ))}

          {/* Add-task inline for ungrouped, only if ungrouped section exists */}
          {ungrouped.length > 0 && (
            <button className="add-task-inline">
              <span className="plus">+</span> Add task
            </button>
          )}

          {/* Lanes */}
          {lanes.map((lane, i) => (
            <React.Fragment key={i}>
              <div className="swimlane">
                <span>{lane.name}</span>
                <span className="lane-count">{lane.tasks.filter(t => !t.done).length}/{lane.tasks.length}</span>
                <span className="line" />
              </div>
              {lane.tasks.map(t => (
                <TaskRow
                  key={t.id}
                  task={t}
                  state={t.id === selectedTaskId ? 'selected' : (t.state || 'normal')}
                />
              ))}
              <button className="add-task-inline">
                <span className="plus">+</span> Add to {lane.name.toLowerCase()}
              </button>
            </React.Fragment>
          ))}
        </div>
      )}

      <div className="col-footer">
        <button className="add-stage">
          <Icon.plus /> Add stage
        </button>
      </div>
    </div>
  );
}

function NewSectionColumn() {
  return (
    <div className="col new">
      <button>
        <span className="icon">+</span>
        <span>New section</span>
      </button>
    </div>
  );
}

// ────────── FILTER BAR ──────────
function FilterBar({ active = 'all' }) {
  const filters = [
    { id: 'all', label: 'All', count: 47 },
    { id: 'pending', label: 'Pending', count: 32 },
    { id: 'done', label: 'Done', count: 15 },
    null, // divider
    { id: 'rush', label: 'Rush', count: 2, dot: 'rush' },
    { id: 'high', label: 'High', count: 8, dot: 'high' },
    { id: 'med',  label: 'Medium', count: 14, dot: 'med' },
    { id: 'low',  label: 'Low', count: 23, dot: 'low' },
  ];
  return (
    <div className="filter-bar">
      <div className="filter-pills">
        {filters.map((f, i) =>
          f === null
            ? <span key={i} className="divider" />
            : (
              <button key={f.id} className={"pill " + (active === f.id ? 'active' : '')}>
                {f.dot && <span className={"dot " + f.dot} />}
                {f.label}
                <span className="count">{f.count}</span>
              </button>
            )
        )}
      </div>
      <div className="pushright row-gap-2">
        <button className="btn sm">Collapse all</button>
        <button className="btn sm">Expand all</button>
        <span className="divider" />
        <button className="icon-btn" title="Search"><Icon.search /></button>
      </div>
    </div>
  );
}

// ────────── PROJECT HEADER ──────────
function ProjectHeader({ name = 'Q2 Launch Plan', done = 12, total = 47, briefing = false }) {
  const pct = Math.round((done / total) * 100);
  return (
    <div className="proj-header">
      <div className="name-block">
        <div className="crumbs">
          <span>Workspace</span><span className="sep">/</span><span>Projects</span>
        </div>
        <h1 className="proj-name">{name}</h1>
        <div className="progress-row">
          <div className="progress-bar"><i style={{ width: pct + '%' }} /></div>
          <span className="progress-text">{done} of {total} · {pct}%</span>
        </div>
      </div>
      <div className="actions">
        <button className="btn"><Icon.zap />Briefing</button>
        <button className="btn">Export</button>
        <button className="btn primary"><Icon.zap />Focus</button>
      </div>
    </div>
  );
}

// ────────── IN-PROGRESS SIDEBAR (desktop) ──────────
function InProgressSidebar() {
  const feature = {
    section: 'API · Backend',
    title: 'Wire up rate-limiting on the /generate endpoint',
    due: 'Today',
    started: 'Started 32m ago',
  };
  const others = [
    { section: 'Design', title: 'Audit empty-states across project & focus screens', due: 'Fri' },
    { section: 'Marketing', title: 'Draft launch email v2 — focus mode angle', due: 'Tue' },
    { section: 'API · Backend', title: 'Document the AI task-parser response shape', due: '—' },
  ];
  return (
    <aside className="ip-sidebar">
      <h3>In progress <span className="count">4</span></h3>

      <div className="ip-card feature">
        <span className="ip-section-tag">{feature.section}</span>
        <div className="ip-title">{feature.title}</div>
        <div className="ip-meta">
          <span style={{color: 'var(--accent)'}}>● {feature.due}</span>
          <span>·</span>
          <span>{feature.started}</span>
        </div>
        <div className="ip-actions">
          <button className="ip-mini go">Focus →</button>
          <button className="ip-mini">Complete</button>
        </div>
      </div>

      {others.map((t, i) => (
        <div key={i} className="ip-card">
          <span className="ip-section-tag">{t.section}</span>
          <div className="ip-title">{t.title}</div>
          <div className="ip-meta">
            <span>Due {t.due}</span>
          </div>
        </div>
      ))}

      <button className="btn ghost" style={{ justifyContent: 'center', marginTop: 'auto' }}>
        View all in-progress →
      </button>
    </aside>
  );
}

// ────────── TASK DETAIL PANEL (desktop right slide) ──────────
function TaskPanel({ task }) {
  const t = task || {
    title: 'Wire up rate-limiting on the /generate endpoint',
    section: 'API · Backend',
    stage: 'In review',
    priority: 'high',
    status: 'in-progress',
    due: 'Tue, May 19',
    relative: 'in 5 days',
    notes: 'Use leaky-bucket per-user. Cap at 12 req/min during open beta. Coordinate with @sam on cache-warmer that hits the same path.',
    tags: ['api', 'beta'],
  };
  return (
    <div className="task-panel">
      <header>
        <div className="crumbs">
          <strong>{t.section}</strong> · {t.stage}
        </div>
        <div className="row-gap-2">
          <button className="icon-btn" title="More"><Icon.more /></button>
          <button className="icon-btn" title="Close"><Icon.close /></button>
        </div>
      </header>

      <div className="body">
        <h2 className="tp-title">{t.title}</h2>

        <div className="tp-section">
          <div className="lbl">Status</div>
          <div className="tp-status">
            <button className={t.status === 'pending' ? 'active' : ''}>
              <span className="dot" /> Pending
            </button>
            <button className={t.status === 'in-progress' ? 'active' : ''}>
              <span className="dot" /> In progress
            </button>
            <button className={t.status === 'done' ? 'active done' : ''}>
              <span className="dot" /> Done
            </button>
          </div>
        </div>

        <div className="tp-section">
          <div className="lbl">Priority</div>
          <div className="tp-priority">
            <button className={"rush " + (t.priority === 'rush' ? 'active' : '')}>Rush</button>
            <button className={"high " + (t.priority === 'high' ? 'active' : '')}>High</button>
            <button className={"med "  + (t.priority === 'med'  ? 'active' : '')}>Med</button>
            <button className={t.priority === 'low' ? 'active' : ''}>Low</button>
          </div>
        </div>

        <div className="tp-section">
          <div className="lbl">Due</div>
          <div className="tp-date">
            <span className="cal-icon"><Icon.cal /></span>
            <span>{t.due}</span>
            <span className="relative">{t.relative}</span>
          </div>
        </div>

        <div className="tp-section">
          <div className="lbl">Notes</div>
          <textarea className="tp-notes" defaultValue={t.notes} />
        </div>

        <div className="tp-section">
          <div className="lbl">Tags</div>
          <div className="tp-tags">
            {t.tags.map((tag, i) => <span key={i} className="chip tag">#{tag}</span>)}
            <button className="tag-add">+ tag</button>
          </div>
        </div>

        <div className="tp-section">
          <div className="lbl">Discussion</div>
          <div className="tp-discussion-placeholder">
            <span className="badge">Future</span>
            <div>Thread on this task — @mentions, AI suggestions, decisions captured here.</div>
          </div>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { TaskRow, Column, NewSectionColumn, FilterBar, ProjectHeader, InProgressSidebar, TaskPanel });
