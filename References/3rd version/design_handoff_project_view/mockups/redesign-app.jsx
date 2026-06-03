// Tasker Redesign — main app, wraps frames in DesignCanvas

const DESKTOP_W = 1400;
const DESKTOP_H = 860;
const MOBILE_W = 390;
const MOBILE_H = 810;

function IntroCard() {
  return (
    <div className="canvas-intro" data-screen-label="00 Intro">
      <div className="kicker">Redesign · Project View · v1</div>
      <h1>Tasker — horizontal columns, two-axis project view</h1>
      <p>
        Sections become columns; tasks stack vertically inside them; groups (stages) are swimlane dividers within a column.
        Same model on desktop and mobile — desktop pans horizontally, mobile snap-scrolls between full-viewport columns.
        Tokens, fonts, and the existing TaskItem internals are preserved exactly.
      </p>
      <p style={{ color: 'var(--mute)', fontSize: 12 }}>
        Click any artboard's <strong style={{ color: 'var(--ink-2)' }}>↗</strong> to open it fullscreen. Annotations sit beside each frame.
      </p>

      <div className="grid">
        <div className="item">
          <div className="k">Horizontal axis</div>
          <div className="v">Sections → columns. Pan to see all.</div>
        </div>
        <div className="item">
          <div className="k">Vertical axis</div>
          <div className="v">Tasks stack inside a column. Stages = swimlanes.</div>
        </div>
        <div className="item">
          <div className="k">Task detail</div>
          <div className="v">Right slide-in (desktop) · bottom sheet (mobile).</div>
        </div>
        <div className="item">
          <div className="k">In-progress</div>
          <div className="v">Fixed sidebar desktop · floating sheet mobile.</div>
        </div>
      </div>

      <div className="token-row">
        {[
          ['paper', '#FBFAF6'],
          ['surf', '#F0EDE5'],
          ['line', '#D4D0C8'],
          ['ink', '#1A1916'],
          ['mute', '#6B6867'],
          ['accent', '#D97757'],
        ].map(([k, v]) => (
          <div key={k} className="swatch">
            <span className="chip-color" style={{ background: v }} />
            <span>{k}</span>
            <span style={{ color: 'var(--mute)' }}>{v}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// A small annotation block — appears in the section's row, beside frames
function Notes({ items }) {
  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      gap: 14,
      padding: '12px 0',
      width: 280,
      flex: '0 0 280px',
    }}>
      {items.map((n, i) => (
        <div key={i} style={{
          background: 'var(--paper)',
          border: '1px solid var(--line-2)',
          borderRadius: 8,
          padding: '12px 14px',
        }}>
          <div style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
            color: 'var(--accent)',
            marginBottom: 6,
          }}>{n.k}</div>
          <div style={{ fontSize: 12.5, lineHeight: 1.55, color: 'var(--ink-2)' }}>
            {n.v}
          </div>
        </div>
      ))}
    </div>
  );
}

function App() {
  const { DesignCanvas, DCSection, DCArtboard, DCPostIt } = window;

  return (
    <DesignCanvas
      title="Tasker · Project View Redesign"
      subtitle="Annotated mockups · v1 · May 2026"
    >
      {/* INTRO */}
      <DCSection id="intro" title="Overview" subtitle="The model, the tokens, the deliverables">
        <DCArtboard id="intro-card" label="Brief & tokens" width={920} height={420}>
          <IntroCard />
        </DCArtboard>
      </DCSection>

      {/* DESKTOP */}
      <DCSection id="desktop" title="Desktop · Project view" subtitle="1440px reference width. Header → filter bar → board (columns + right sidebar)">
        <DCArtboard id="d-normal" label="Normal state" width={DESKTOP_W} height={DESKTOP_H} data-screen-label="01 Desktop · Normal">
          <FrameDesktopNormal />
        </DCArtboard>

        <DCArtboard id="d-panel" label="Task detail panel open" width={DESKTOP_W} height={DESKTOP_H} data-screen-label="02 Desktop · Task panel open">
          <FrameDesktopPanel />
        </DCArtboard>
      </DCSection>

      {/* HORIZONTAL SCROLL AFFORDANCES */}
      <DCSection id="affordance" title="Horizontal-scroll affordance" subtitle="Two options. Pick one — both shown at the same zoom for comparison.">
        <DCArtboard id="aff-a" label="A · Edge arrows on hover" width={DESKTOP_W} height={DESKTOP_H} data-screen-label="03 Affordance A · Edge arrows">
          <FrameAffordanceArrows />
        </DCArtboard>
        <DCArtboard id="aff-b" label="B · Rail + shift-scroll hint  ◀ recommended" width={DESKTOP_W} height={DESKTOP_H} data-screen-label="04 Affordance B · Rail">
          <FrameAffordanceRail />
        </DCArtboard>
      </DCSection>

      {/* COMPONENT STATES */}
      <DCSection id="states" title="Column · interaction states" subtitle="Normal · Collapsed · Empty · Dragging · New-section">
        <DCArtboard id="col-states" label="Column states" width={1620} height={720} data-screen-label="05 Column states">
          <FrameColumnStates />
        </DCArtboard>
      </DCSection>

      <DCSection id="task-states" title="Task row · interaction states" subtitle="Internal task design is unchanged — these are container states the new layout introduces">
        <DCArtboard id="task-state-grid" label="Task row states" width={920} height={660} data-screen-label="06 Task row states">
          <FrameTaskStates />
        </DCArtboard>
      </DCSection>

      {/* MOBILE */}
      <DCSection id="mobile" title="Mobile · Project view" subtitle="Same two-axis model. Each column is full-viewport with snap scrolling. 390×810 (iPhone 14).">
        <DCArtboard id="m-normal" label="Single column view" width={MOBILE_W} height={MOBILE_H} data-screen-label="07 Mobile · Normal">
          <FrameMobileNormal />
        </DCArtboard>
        <DCArtboard id="m-swipe" label="Mid-swipe to next column" width={MOBILE_W} height={MOBILE_H} data-screen-label="08 Mobile · Swipe">
          <FrameMobileSwipe />
        </DCArtboard>
        <DCArtboard id="m-task" label="Task detail bottom sheet" width={MOBILE_W} height={MOBILE_H} data-screen-label="09 Mobile · Task sheet">
          <FrameMobileTaskSheet />
        </DCArtboard>
        <DCArtboard id="m-ip" label="In-progress bottom sheet" width={MOBILE_W} height={MOBILE_H} data-screen-label="10 Mobile · In-progress sheet">
          <FrameMobileIPSheet />
        </DCArtboard>
      </DCSection>
    </DesignCanvas>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
