// Tasker Redesign — full-frame compositions for the design canvas

const { SECTIONS } = window.TASKER_DATA;

// Helper — render N columns inline
function ColRow({ collapsedIds = [], selectedTaskId, omitNewSection }) {
  return (
    <>
      {SECTIONS.map((s, i) => (
        <Column
          key={s.id}
          section={{ name: s.name, done: s.done, total: s.total }}
          ungrouped={s.ungrouped}
          lanes={s.lanes}
          empty={s.empty}
          state={collapsedIds.includes(s.id) ? 'collapsed' : 'normal'}
          selectedTaskId={selectedTaskId}
        />
      ))}
      {!omitNewSection && <NewSectionColumn />}
    </>
  );
}

// ─────────────────────────────────────────────
// FRAME 1 — Full desktop, normal state
// ─────────────────────────────────────────────
function FrameDesktopNormal() {
  return (
    <div className="board" style={{ display: 'flex', flexDirection: 'column' }}>
      <ProjectHeader />
      <FilterBar active="all" />
      <div className="board-area">
        <div className="cols-wrap">
          <div className="cols-scroll">
            <ColRow />
          </div>
          {/* Variant B affordance shown by default */}
          <div className="h-rail">
            <i style={{ width: '46%', marginLeft: '4%' }} />
          </div>
          <div className="h-hint">
            <span className="kbd">⇧</span><span>+</span><span className="kbd">scroll</span>
            <span>to pan</span>
          </div>
        </div>
        <InProgressSidebar />
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// FRAME 2 — Desktop with task detail panel open
// ─────────────────────────────────────────────
function FrameDesktopPanel() {
  return (
    <div className="board" style={{ display: 'flex', flexDirection: 'column' }}>
      <ProjectHeader />
      <FilterBar active="all" />
      <div className="board-area">
        <div className="cols-wrap">
          <div className="cols-scroll">
            <ColRow selectedTaskId="a-1" />
          </div>
          <div className="h-rail">
            <i style={{ width: '46%', marginLeft: '4%' }} />
          </div>
        </div>
        <InProgressSidebar />
        <div className="scrim" style={{
          left: 'auto', width: 'calc(100% - 380px - 288px)', background: 'rgba(26,25,22,0.08)'
        }} />
        <TaskPanel />
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// FRAME 3 — Affordance A: Edge arrows on hover
// ─────────────────────────────────────────────
function FrameAffordanceArrows() {
  return (
    <div className="board" style={{ display: 'flex', flexDirection: 'column' }}>
      <ProjectHeader />
      <FilterBar active="all" />
      <div className="board-area">
        <div className="cols-wrap">
          <div className="cols-scroll">
            <ColRow />
          </div>
          <div className="edge-arrow left"><Icon.chevronL /></div>
          <div className="edge-arrow right"><Icon.chevronR /></div>
        </div>
        <InProgressSidebar />
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// FRAME 4 — Affordance B: Shift+scroll hint rail
// ─────────────────────────────────────────────
function FrameAffordanceRail() {
  return (
    <div className="board" style={{ display: 'flex', flexDirection: 'column' }}>
      <ProjectHeader />
      <FilterBar active="all" />
      <div className="board-area">
        <div className="cols-wrap">
          <div className="cols-scroll">
            <ColRow />
          </div>
          <div className="h-rail">
            <i style={{ width: '38%', marginLeft: '12%' }} />
          </div>
          <div className="h-hint">
            <span className="kbd">⇧</span><span>+</span><span className="kbd">scroll</span>
            <span>to pan · or drag</span>
          </div>
        </div>
        <InProgressSidebar />
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// FRAME 5 — Column states grid (normal, collapsed, empty, dragging)
// ─────────────────────────────────────────────
function FrameColumnStates() {
  const sample = SECTIONS[0]; // Design
  return (
    <div className="board" style={{ padding: 28, overflow: 'auto' }}>
      <div style={{ display: 'flex', gap: 20, alignItems: 'flex-start', minHeight: '100%' }}>
        {/* Normal */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div className="annot-label">Normal</div>
          <div style={{ height: 620 }}>
            <Column
              section={{ name: sample.name, done: sample.done, total: sample.total }}
              ungrouped={sample.ungrouped}
              lanes={sample.lanes.slice(0, 2)}
            />
          </div>
        </div>

        {/* Collapsed */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div className="annot-label">Collapsed</div>
          <div style={{ height: 620 }}>
            <Column
              section={{ name: 'Marketing', done: 1, total: 8 }}
              state="collapsed"
            />
          </div>
        </div>

        {/* Empty */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div className="annot-label">Empty</div>
          <div style={{ height: 620 }}>
            <Column
              section={{ name: 'QA · Polish', done: 0, total: 0 }}
              empty
            />
          </div>
        </div>

        {/* Dragging — header lifted */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div className="annot-label">Dragging (column reorder)</div>
          <div style={{ height: 620, position: 'relative' }}>
            <div style={{
              transform: 'rotate(-2deg) translateY(-4px)',
              boxShadow: '0 18px 40px rgba(26,25,22,0.18), 0 0 0 1.5px var(--accent)',
              borderRadius: 10,
              height: '100%',
            }}>
              <Column
                section={{ name: sample.name, done: sample.done, total: sample.total }}
                ungrouped={sample.ungrouped}
                lanes={sample.lanes.slice(0, 1)}
              />
            </div>
            {/* drop indicator next to it */}
            <div style={{
              position: 'absolute',
              top: 0, bottom: 0,
              right: -14, width: 4,
              background: 'var(--accent)',
              borderRadius: 2,
            }} />
          </div>
        </div>

        {/* New section column */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div className="annot-label">+ New section</div>
          <div style={{ height: 620 }}>
            <NewSectionColumn />
          </div>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// FRAME 6 — Task row states
// ─────────────────────────────────────────────
function FrameTaskStates() {
  const base = { title: 'Wire up rate-limiting on the /generate endpoint', priority: 'high', due: 'Tue', tags: ['beta'] };
  const states = [
    { lbl: 'Default', task: base, state: 'normal' },
    { lbl: 'Hover (tools revealed)', task: base, state: 'hover' },
    { lbl: 'In progress', task: { ...base, inProgress: true, due: 'Today', today: true }, state: 'in-progress' },
    { lbl: 'Done', task: { ...base, done: true, priority: null, due: null }, state: 'done' },
    { lbl: 'Selected (panel open)', task: base, state: 'selected' },
    { lbl: 'Dragging', task: base, state: 'dragging' },
    { lbl: 'Drop placeholder', task: null, state: 'placeholder' },
    { lbl: 'Overdue', task: { ...base, priority: 'rush', due: 'Yesterday', overdue: true }, state: 'normal' },
  ];

  return (
    <div className="board" style={{ padding: 32, overflow: 'auto' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 18 }}>
        {states.map((s, i) => (
          <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div className="annot-label">{s.lbl}</div>
            <div style={{
              background: 'var(--paper)',
              border: '1px solid var(--line-2)',
              borderRadius: 8,
              padding: '6px 6px',
              minHeight: 56,
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'center',
            }}
              // Force-show tools on the hover example
              className={s.state === 'hover' ? 'force-hover-row' : ''}
            >
              {s.state === 'placeholder'
                ? <div className="task drop-placeholder" />
                : <TaskRow task={s.task} state={s.state === 'hover' ? 'normal' : s.state} />
              }
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// MOBILE FRAMES
// ─────────────────────────────────────────────
function MobileStatusBar() {
  return (
    <div className="statusbar">
      <span>9:41</span>
      <div className="icons">
        <Icon.signal /><Icon.wifi /><Icon.battery />
      </div>
    </div>
  );
}

// FRAME 7 — Mobile project view (single column visible, dots, FAB)
function FrameMobileNormal() {
  const s = SECTIONS[2]; // Web App — has rich ungrouped + lanes
  return (
    <div className="mobile">
      <MobileStatusBar />
      <div className="m-topbar">
        <button className="icon-btn"><Icon.chevronL /></button>
        <div className="name-stack">
          <div className="crumbs">Q2 Launch</div>
          <div className="proj-name">Web App</div>
        </div>
        <div className="actions">
          <button className="icon-btn"><Icon.zap /></button>
          <button className="icon-btn"><Icon.more /></button>
        </div>
      </div>
      <div className="m-progress">
        <span className="count">5/14</span>
        <div className="bar"><i style={{ width: '36%' }} /></div>
        <span className="count">36%</span>
      </div>
      <div className="m-filter">
        <button className="pill active">All <span className="count">47</span></button>
        <button className="pill">Pending <span className="count">32</span></button>
        <button className="pill">Done <span className="count">15</span></button>
        <button className="pill"><span className="dot rush" />Rush</button>
        <button className="pill"><span className="dot high" />High</button>
        <button className="pill"><span className="dot med" />Med</button>
      </div>
      <div className="m-dots">
        <span className="dot" />
        <span className="dot" />
        <span className="dot active" />
        <span className="dot" />
        <span className="dot" />
      </div>
      <div className="m-cols">
        <div className="m-col">
          <Column
            section={{ name: s.name, done: s.done, total: s.total }}
            ungrouped={s.ungrouped}
            lanes={s.lanes}
          />
        </div>
      </div>
      <button className="m-ip-fab">
        <Icon.play />
        In progress
        <span className="badge">4</span>
      </button>
    </div>
  );
}

// FRAME 8 — Mobile mid-swipe (peek of next column)
function FrameMobileSwipe() {
  const a = SECTIONS[1]; // API
  const b = SECTIONS[2]; // Web
  return (
    <div className="mobile">
      <MobileStatusBar />
      <div className="m-topbar">
        <button className="icon-btn"><Icon.chevronL /></button>
        <div className="name-stack">
          <div className="crumbs">Q2 Launch</div>
          <div className="proj-name">API · Backend → Web App</div>
        </div>
        <div className="actions">
          <button className="icon-btn"><Icon.more /></button>
        </div>
      </div>
      <div className="m-progress">
        <span className="count">12/47</span>
        <div className="bar"><i style={{ width: '25%' }} /></div>
        <span className="count">25%</span>
      </div>
      <div className="m-filter">
        <button className="pill active">All <span className="count">47</span></button>
        <button className="pill">Pending <span className="count">32</span></button>
        <button className="pill">Done <span className="count">15</span></button>
        <button className="pill"><span className="dot rush" />Rush</button>
      </div>
      <div className="m-dots">
        <span className="dot" />
        <span className="dot active" />
        <span className="dot" />
        <span className="dot" />
        <span className="dot" />
      </div>
      <div className="m-cols" style={{ transform: 'translateX(-40%)' }}>
        <div className="m-col">
          <Column
            section={{ name: a.name, done: a.done, total: a.total }}
            ungrouped={a.ungrouped}
            lanes={a.lanes.slice(0,2)}
          />
        </div>
        <div className="m-col">
          <Column
            section={{ name: b.name, done: b.done, total: b.total }}
            ungrouped={b.ungrouped}
            lanes={b.lanes.slice(0,1)}
          />
        </div>
      </div>
    </div>
  );
}

// FRAME 9 — Mobile task detail bottom sheet
function FrameMobileTaskSheet() {
  const s = SECTIONS[2];
  return (
    <div className="mobile">
      <MobileStatusBar />
      <div className="m-topbar">
        <button className="icon-btn"><Icon.chevronL /></button>
        <div className="name-stack">
          <div className="crumbs">Q2 Launch</div>
          <div className="proj-name">Web App</div>
        </div>
        <div className="actions"><button className="icon-btn"><Icon.more /></button></div>
      </div>
      <div className="m-progress">
        <span className="count">5/14</span>
        <div className="bar"><i style={{ width: '36%' }} /></div>
        <span className="count">36%</span>
      </div>
      <div className="m-filter">
        <button className="pill active">All <span className="count">47</span></button>
        <button className="pill">Pending</button>
        <button className="pill">Done</button>
      </div>
      <div className="m-cols">
        <div className="m-col" style={{ opacity: 0.5 }}>
          <Column
            section={{ name: s.name, done: s.done, total: s.total }}
            ungrouped={s.ungrouped}
            lanes={s.lanes}
            selectedTaskId="w-u1"
          />
        </div>
      </div>
      <div className="sheet-scrim" />
      <div className="sheet" style={{ height: '62%' }}>
        <div className="handle" />
        <div className="sheet-body">
          <div className="row-gap-2" style={{ justifyContent: 'space-between' }}>
            <div className="crumbs" style={{
              fontFamily: 'var(--font-mono)', fontSize: 10,
              letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--mute)'
            }}>
              Web App · Ungrouped
            </div>
            <button className="icon-btn"><Icon.close /></button>
          </div>
          <h2 style={{ fontSize: 18, fontWeight: 600, margin: 0, lineHeight: 1.3 }}>
            Fix the keyboard trap in Focus mode discuss sheet
          </h2>

          <div className="tp-section">
            <div className="lbl">Status</div>
            <div className="tp-status">
              <button>Pending</button>
              <button className="active">In progress</button>
              <button>Done</button>
            </div>
          </div>

          <div className="tp-section">
            <div className="lbl">Priority</div>
            <div className="tp-priority">
              <button className="rush active">Rush</button>
              <button className="high">High</button>
              <button className="med">Med</button>
              <button>Low</button>
            </div>
          </div>

          <div className="tp-section">
            <div className="lbl">Due</div>
            <div className="tp-date">
              <span className="cal-icon"><Icon.cal /></span>
              <span>Today · May 14</span>
              <span className="relative">in 0 days</span>
            </div>
          </div>

          <div className="tp-section">
            <div className="lbl">Notes</div>
            <textarea className="tp-notes" defaultValue="Tab cycles between the discuss textarea and the regenerate button only. Need to include the close-X and the focus mode toggle." />
          </div>
        </div>
      </div>
    </div>
  );
}

// FRAME 10 — Mobile in-progress sheet
function FrameMobileIPSheet() {
  const s = SECTIONS[2];
  return (
    <div className="mobile">
      <MobileStatusBar />
      <div className="m-topbar">
        <button className="icon-btn"><Icon.chevronL /></button>
        <div className="name-stack">
          <div className="crumbs">Q2 Launch</div>
          <div className="proj-name">Web App</div>
        </div>
        <div className="actions"><button className="icon-btn"><Icon.more /></button></div>
      </div>
      <div className="m-progress">
        <span className="count">5/14</span>
        <div className="bar"><i style={{ width: '36%' }} /></div>
        <span className="count">36%</span>
      </div>
      <div className="m-filter">
        <button className="pill active">All</button>
        <button className="pill">Pending</button>
        <button className="pill">Done</button>
      </div>
      <div className="m-cols">
        <div className="m-col" style={{ opacity: 0.55 }}>
          <Column
            section={{ name: s.name, done: s.done, total: s.total }}
            ungrouped={s.ungrouped}
            lanes={s.lanes}
          />
        </div>
      </div>
      <div className="sheet-scrim" />
      <div className="sheet" style={{ height: '70%' }}>
        <div className="handle" />
        <div className="sheet-body">
          <div className="row-gap-2" style={{ justifyContent: 'space-between' }}>
            <h3 style={{
              fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: '0.1em',
              textTransform: 'uppercase', color: 'var(--mute)', margin: 0,
            }}>
              In progress <span style={{ color: 'var(--ink-2)' }}>· 4</span>
            </h3>
            <button className="icon-btn"><Icon.close /></button>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div className="ip-card feature">
              <span className="ip-section-tag">API · Backend</span>
              <div className="ip-title">Wire up rate-limiting on the /generate endpoint</div>
              <div className="ip-meta">
                <span style={{ color: 'var(--accent)' }}>● Today</span>
                <span>·</span>
                <span>Started 32m ago</span>
              </div>
              <div className="ip-actions">
                <button className="ip-mini go">Focus →</button>
                <button className="ip-mini">Complete</button>
              </div>
            </div>
            <div className="ip-card">
              <span className="ip-section-tag">Design</span>
              <div className="ip-title">Audit empty-states across project & focus screens</div>
              <div className="ip-meta"><span>Due Fri</span></div>
            </div>
            <div className="ip-card">
              <span className="ip-section-tag">Marketing</span>
              <div className="ip-title">Draft launch email v2 — focus mode angle</div>
              <div className="ip-meta"><span>Due Tue</span></div>
            </div>
            <div className="ip-card">
              <span className="ip-section-tag">API · Backend</span>
              <div className="ip-title">Document the AI task-parser response shape</div>
              <div className="ip-meta"><span>No due date</span></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, {
  FrameDesktopNormal,
  FrameDesktopPanel,
  FrameAffordanceArrows,
  FrameAffordanceRail,
  FrameColumnStates,
  FrameTaskStates,
  FrameMobileNormal,
  FrameMobileSwipe,
  FrameMobileTaskSheet,
  FrameMobileIPSheet,
});
