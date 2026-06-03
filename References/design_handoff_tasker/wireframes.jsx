// Tasker wireframes — strict greyscale, sketchy lo-fi
// All variants laid out as DCArtboards on a DesignCanvas.

const W = {
  ink: '#111',
  ink2: '#333',
  mute: '#6b6b6b',
  mute2: '#9a9a9a',
  line: '#cfcfcf',
  line2: '#e6e6e6',
  surf: '#f5f5f5',
  surf2: '#fafafa',
  paper: '#fff',
  hand: '"Caveat", "Architects Daughter", cursive',
  ui: '"Inter", system-ui, sans-serif',
  mono: '"JetBrains Mono", ui-monospace, monospace',
};

// ── tiny primitives ─────────────────────────────────────────────
const Box = ({ style, children, ...r }) => (
  <div style={{ ...style }} {...r}>{children}</div>
);

const Hand = ({ children, size = 20, rot = 0, style, ...r }) => (
  <span style={{
    fontFamily: W.hand, fontSize: size, lineHeight: 1, color: W.ink,
    transform: `rotate(${rot}deg)`, display: 'inline-block', ...style,
  }} {...r}>{children}</span>
);

const Anno = ({ children, rot = -2, side = 'left', top = 0, color = W.mute }) => (
  <div style={{
    position: 'absolute', [side]: -8, top, transform: `translateX(${side === 'left' ? '-100%' : '100%'}) rotate(${rot}deg)`,
    fontFamily: W.hand, fontSize: 16, color, whiteSpace: 'nowrap', pointerEvents: 'none',
  }}>{children}</div>
);

// striped placeholder
const Stripe = ({ w = '100%', h = 40, label, style }) => (
  <div style={{
    width: w, height: h,
    backgroundImage: 'repeating-linear-gradient(135deg, #ececec 0 6px, #f6f6f6 6px 12px)',
    border: `1px dashed ${W.line}`, borderRadius: 4,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontFamily: W.mono, fontSize: 9, color: W.mute2, letterSpacing: 0.5,
    textTransform: 'uppercase', ...style,
  }}>{label}</div>
);

// dashed sketch border
const Sketch = ({ children, style, dashed = true, radius = 8, ...r }) => (
  <div style={{
    border: `1.25px ${dashed ? 'dashed' : 'solid'} ${W.ink}`,
    borderRadius: radius, background: W.paper, ...style,
  }} {...r}>{children}</div>
);

// priority chip — greyscale only, differentiate via fill density
const Pri = ({ level = 'M', size = 'sm' }) => {
  const map = {
    R: { bg: W.ink,  fg: '#fff',   label: 'RUSH' },
    H: { bg: '#444', fg: '#fff',   label: 'HIGH' },
    M: { bg: '#fff', fg: W.ink,    label: 'MED',  border: true },
    L: { bg: '#fff', fg: W.mute,   label: 'LOW',  border: true, dashed: true },
  };
  const s = map[level];
  const fs = size === 'sm' ? 9 : 10;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      fontFamily: W.mono, fontSize: fs, fontWeight: 600, letterSpacing: 0.6,
      padding: '2px 6px', borderRadius: 3,
      background: s.bg, color: s.fg,
      border: s.border ? `1px ${s.dashed ? 'dashed' : 'solid'} ${W.ink}` : 'none',
    }}>{s.label}</span>
  );
};

// task row — checkbox + title + meta
const Task = ({ done, prog, title, pri, due, tags = [], compact, dim }) => (
  <div style={{
    display: 'flex', alignItems: 'flex-start', gap: 10,
    padding: compact ? '7px 10px' : '10px 12px',
    borderBottom: `1px dashed ${W.line2}`,
    opacity: dim ? 0.5 : 1,
  }}>
    <Box style={{
      width: 16, height: 16, borderRadius: 3, marginTop: 2,
      border: `1.25px solid ${W.ink}`,
      background: done ? W.ink : prog ? `repeating-linear-gradient(45deg, #000 0 2px, #fff 2px 4px)` : '#fff',
      flexShrink: 0,
    }} />
    <Box style={{ flex: 1, minWidth: 0 }}>
      <Box style={{
        fontFamily: W.ui, fontSize: 13, color: W.ink, fontWeight: 500,
        textDecoration: done ? 'line-through' : 'none',
        textDecorationThickness: '1.5px',
      }}>{title}</Box>
      <Box style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
        {pri && <Pri level={pri} />}
        {due && (
          <span style={{ fontFamily: W.mono, fontSize: 9.5, color: W.mute, letterSpacing: 0.4 }}>
            ◷ {due}
          </span>
        )}
        {tags.map(t => (
          <span key={t} style={{
            fontFamily: W.mono, fontSize: 9, color: W.ink,
            border: `1px solid ${W.line}`, padding: '1px 5px', borderRadius: 10,
          }}>#{t}</span>
        ))}
      </Box>
    </Box>
    <Hand size={14} rot={2} style={{ color: W.mute2, flexShrink: 0, marginTop: 2 }}>⋯</Hand>
  </div>
);

// section card frame
const Section = ({ title, count, children, collapsed, style }) => (
  <Sketch dashed={false} radius={10} style={{
    background: W.paper, marginBottom: 14, overflow: 'hidden', ...style,
  }}>
    <Box style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '10px 14px', borderBottom: collapsed ? 'none' : `1px solid ${W.line2}`,
      background: W.surf2,
    }}>
      <Box style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Hand size={16} rot={collapsed ? -90 : 0} style={{ color: W.ink2 }}>▾</Hand>
        <span style={{ fontFamily: W.ui, fontSize: 13, fontWeight: 700, letterSpacing: 0.2, color: W.ink }}>
          {title}
        </span>
        <span style={{ fontFamily: W.mono, fontSize: 10, color: W.mute }}>{count}</span>
      </Box>
      <Hand size={18} style={{ color: W.mute }}>+</Hand>
    </Box>
    {!collapsed && children}
  </Sketch>
);

// stage group inside a section
const Stage = ({ label, count, children, last }) => (
  <Box style={{ borderBottom: last ? 'none' : `1px solid ${W.line2}` }}>
    <Box style={{
      display: 'flex', alignItems: 'center', gap: 6,
      padding: '7px 14px', background: '#fff',
    }}>
      <Hand size={12} style={{ color: W.mute }}>▸</Hand>
      <span style={{
        fontFamily: W.mono, fontSize: 9.5, fontWeight: 700, color: W.ink,
        letterSpacing: 1, textTransform: 'uppercase',
      }}>{label}</span>
      <Box style={{ flex: 1, height: 1, borderTop: `1px dashed ${W.line}` }} />
      <span style={{ fontFamily: W.mono, fontSize: 9, color: W.mute2 }}>{count}</span>
    </Box>
    {children}
  </Box>
);

// status bar + bottom nav
const StatusBar = () => (
  <Box style={{
    height: 28, display: 'flex', alignItems: 'center',
    justifyContent: 'space-between', padding: '0 16px',
    fontFamily: W.mono, fontSize: 10, color: W.ink, fontWeight: 600,
  }}>
    <span>9:41</span>
    <span>● ● ●</span>
  </Box>
);

const BottomNav = ({ active = 'focus' }) => {
  const items = [
    { k: 'focus',    label: 'Focus',    glyph: '◉' },
    { k: 'projects', label: 'Projects', glyph: '◰' },
    { k: 'briefing', label: 'Briefing', glyph: '☷' },
    { k: 'inbox',    label: 'Inbox',    glyph: '✉' },
    { k: 'me',       label: 'Me',       glyph: '○' },
  ];
  return (
    <Box style={{
      position: 'absolute', left: 0, right: 0, bottom: 0,
      borderTop: `1px solid ${W.line}`, background: W.paper,
      display: 'grid', gridTemplateColumns: 'repeat(5,1fr)',
      paddingBottom: 14,
    }}>
      {items.map(it => (
        <Box key={it.k} style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3,
          padding: '8px 0',
          color: active === it.k ? W.ink : W.mute2,
          borderTop: active === it.k ? `2px solid ${W.ink}` : '2px solid transparent',
          marginTop: -1,
        }}>
          <span style={{ fontSize: 16, lineHeight: 1 }}>{it.glyph}</span>
          <span style={{ fontFamily: W.mono, fontSize: 8.5, letterSpacing: 0.6 }}>
            {it.label.toUpperCase()}
          </span>
        </Box>
      ))}
    </Box>
  );
};

// phone shell
const Phone = ({ children, w = 320, h = 640 }) => (
  <Box style={{
    width: w, height: h, background: W.paper,
    border: `1.5px solid ${W.ink}`, borderRadius: 22,
    overflow: 'hidden', position: 'relative',
    boxShadow: '4px 4px 0 #000',
  }}>{children}</Box>
);

// ────────────────────────────────────────────────────────────────
// MOBILE — FOCUS TAB variants
// ────────────────────────────────────────────────────────────────

// V1 — classic hero "Do This Now" card + queue
const FocusV1 = () => (
  <Phone>
    <StatusBar />
    <Box style={{ padding: '6px 18px 0' }}>
      <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <Box>
          <Hand size={14} rot={-1} style={{ color: W.mute }}>thursday · may 8</Hand>
          <Box style={{ fontFamily: W.ui, fontSize: 22, fontWeight: 800, letterSpacing: -0.5, marginTop: 2 }}>
            Focus
          </Box>
        </Box>
        <Box style={{ width: 28, height: 28, borderRadius: 14, border: `1px solid ${W.ink}`, display: 'grid', placeItems: 'center' }}>
          <Hand size={14}>◐</Hand>
        </Box>
      </Box>
    </Box>

    {/* Hero card */}
    <Box style={{ padding: '14px 16px 0', position: 'relative' }}>
      <Anno top={4} rot={-3}>★ AI-ranked</Anno>
      <Sketch dashed={false} radius={14} style={{
        background: W.ink, color: '#fff', padding: '14px 16px 16px',
        boxShadow: '3px 3px 0 #cfcfcf',
      }}>
        <Box style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <Hand size={14} style={{ color: '#bbb' }}>do this now →</Hand>
          <Box style={{ flex: 1 }} />
          <span style={{
            fontFamily: W.mono, fontSize: 9, padding: '2px 6px',
            background: '#fff', color: '#000', borderRadius: 3, fontWeight: 700, letterSpacing: 0.6,
          }}>RUSH</span>
        </Box>
        <Box style={{ fontFamily: W.ui, fontSize: 17, fontWeight: 700, lineHeight: 1.25 }}>
          Finalize landing page hero copy
        </Box>
        <Box style={{ fontFamily: W.ui, fontSize: 11, color: '#aaa', marginTop: 4, lineHeight: 1.4 }}>
          Website Redesign › Marketing › Launch
        </Box>
        <Box style={{ display: 'flex', gap: 14, marginTop: 12, fontFamily: W.mono, fontSize: 9.5, color: '#bbb' }}>
          <span>◷ DUE 4:00 PM</span>
          <span>~25 MIN</span>
        </Box>
        <Box style={{ display: 'flex', gap: 8, marginTop: 14 }}>
          <Box style={{
            flex: 1, padding: '9px 0', textAlign: 'center', background: '#fff', color: '#000',
            fontFamily: W.ui, fontSize: 12, fontWeight: 700, borderRadius: 6,
          }}>Start</Box>
          <Box style={{
            padding: '9px 14px', textAlign: 'center', border: '1px solid #555', color: '#fff',
            fontFamily: W.ui, fontSize: 12, fontWeight: 600, borderRadius: 6,
          }}>Skip</Box>
        </Box>
      </Sketch>
    </Box>

    {/* Queue */}
    <Box style={{ padding: '18px 16px 0', position: 'relative' }}>
      <Box style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 6 }}>
        <Box style={{ fontFamily: W.ui, fontSize: 11, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase', color: W.mute }}>
          Up next · queue
        </Box>
        <Hand size={14} rot={-1} style={{ color: W.mute2 }}>5 left</Hand>
      </Box>
      <Sketch radius={10} dashed={false}>
        <Task title="Review brand guidelines doc" pri="H" due="Today" tags={['copy']} compact />
        <Task title="Reply to Maria re: pricing tier" pri="M" due="Tomorrow" compact />
        <Task title="Wireframe mobile billing flow" pri="M" due="Fri" tags={['design']} compact />
      </Sketch>
    </Box>

    <BottomNav active="focus" />
  </Phone>
);

// V2 — Timeline / "today's path"
const FocusV2 = () => (
  <Phone>
    <StatusBar />
    <Box style={{ padding: '6px 18px 12px' }}>
      <Box style={{ fontFamily: W.ui, fontSize: 22, fontWeight: 800, letterSpacing: -0.5 }}>Today</Box>
      <Hand size={14} rot={-1} style={{ color: W.mute }}>3 must-do · 5 stretch</Hand>
    </Box>

    <Box style={{ padding: '0 16px', position: 'relative' }}>
      <Anno top={6} rot={-4}>timeline view</Anno>
      {/* timeline rail */}
      <Box style={{ position: 'relative', paddingLeft: 28 }}>
        <Box style={{ position: 'absolute', left: 10, top: 6, bottom: 0, width: 1, background: W.line, borderLeft: `1px dashed ${W.ink2}` }} />

        {/* now marker */}
        <Box style={{ position: 'relative', marginBottom: 12 }}>
          <Box style={{ position: 'absolute', left: -23, top: 8, width: 11, height: 11, background: W.ink, borderRadius: 6 }} />
          <Hand size={13} rot={-1} style={{ color: W.ink, fontWeight: 700 }}>NOW · 9:41 am</Hand>
          <Sketch dashed={false} radius={10} style={{ marginTop: 4, padding: '12px 14px', background: W.ink, color: '#fff' }}>
            <Box style={{ fontFamily: W.mono, fontSize: 9, color: '#bbb', letterSpacing: 0.6 }}>★ DO THIS NOW</Box>
            <Box style={{ fontFamily: W.ui, fontSize: 14, fontWeight: 700, marginTop: 4, lineHeight: 1.3 }}>
              Finalize landing page hero copy
            </Box>
            <Box style={{ fontFamily: W.ui, fontSize: 10, color: '#999', marginTop: 2 }}>Website Redesign › Launch</Box>
          </Sketch>
        </Box>

        {[
          { t: '11:00', title: 'Review brand guidelines', pri: 'H' },
          { t: '1:30',  title: 'Sync w/ Maria — pricing', pri: 'M' },
          { t: '3:00',  title: 'Wireframe billing flow',  pri: 'M' },
          { t: '5:00',  title: 'Daily wrap-up',           pri: 'L' },
        ].map((it, i) => (
          <Box key={i} style={{ position: 'relative', marginBottom: 10 }}>
            <Box style={{
              position: 'absolute', left: -22, top: 10, width: 9, height: 9,
              border: `1.5px solid ${W.ink}`, borderRadius: 5, background: W.paper,
            }} />
            <Box style={{ fontFamily: W.mono, fontSize: 9, color: W.mute, letterSpacing: 0.6 }}>{it.t}</Box>
            <Sketch dashed style={{ marginTop: 3, padding: '8px 10px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontFamily: W.ui, fontSize: 12, color: W.ink }}>{it.title}</span>
              <Pri level={it.pri} />
            </Sketch>
          </Box>
        ))}
      </Box>
    </Box>

    <BottomNav active="focus" />
  </Phone>
);

// V3 — Stack / cards-deck "swipe through queue"
const FocusV3 = () => (
  <Phone>
    <StatusBar />
    <Box style={{ padding: '6px 18px 0' }}>
      <Hand size={14} rot={-1} style={{ color: W.mute }}>focus deck</Hand>
      <Box style={{ fontFamily: W.ui, fontSize: 22, fontWeight: 800, letterSpacing: -0.5 }}>One at a time.</Box>
    </Box>

    <Box style={{ padding: '20px 16px 0', position: 'relative', height: 360 }}>
      <Anno top={20} rot={-3} side="right">swipe ↑ done<br/>swipe ↓ skip</Anno>

      {/* deck of cards */}
      {[2, 1, 0].map((i) => (
        <Sketch
          key={i}
          dashed={false}
          radius={12}
          style={{
            position: 'absolute',
            left: 16 + i * 6, right: 16 + i * 6,
            top: 24 + i * 8,
            padding: '16px 18px',
            background: i === 0 ? W.ink : i === 1 ? '#fff' : W.surf,
            color: i === 0 ? '#fff' : W.ink,
            border: i === 0 ? '1.5px solid #000' : `1px solid ${W.line}`,
            boxShadow: i === 0 ? '4px 6px 0 #cfcfcf' : 'none',
            zIndex: 10 - i,
            height: i === 0 ? 220 : 200,
          }}
        >
          {i === 0 && (
            <>
              <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontFamily: W.mono, fontSize: 9, color: '#aaa', letterSpacing: 0.6 }}>1 / 6</span>
                <span style={{ fontFamily: W.mono, fontSize: 9, padding: '2px 6px', background: '#fff', color: '#000', borderRadius: 3, fontWeight: 700 }}>RUSH</span>
              </Box>
              <Box style={{ fontFamily: W.ui, fontSize: 19, fontWeight: 700, lineHeight: 1.25, marginTop: 24 }}>
                Finalize landing page hero copy
              </Box>
              <Box style={{ fontFamily: W.ui, fontSize: 11, color: '#aaa', marginTop: 8, lineHeight: 1.5 }}>
                Three variants drafted. Pick one and ship to&nbsp;Maria for review.
              </Box>
              <Box style={{ position: 'absolute', bottom: 14, left: 18, right: 18, display: 'flex', justifyContent: 'space-between', fontFamily: W.mono, fontSize: 9, color: '#bbb' }}>
                <span>◷ 4:00 PM</span>
                <span>WEBSITE › LAUNCH</span>
              </Box>
            </>
          )}
        </Sketch>
      ))}
    </Box>

    <Box style={{ position: 'absolute', bottom: 80, left: 0, right: 0, padding: '0 24px', display: 'flex', justifyContent: 'space-between' }}>
      <Box style={{ width: 44, height: 44, border: `1.25px dashed ${W.ink}`, borderRadius: 22, display: 'grid', placeItems: 'center', fontFamily: W.hand, fontSize: 22 }}>↓</Box>
      <Box style={{ fontFamily: W.hand, fontSize: 16, color: W.mute, alignSelf: 'center' }}>skip&nbsp;·&nbsp;snooze&nbsp;·&nbsp;done</Box>
      <Box style={{ width: 44, height: 44, background: W.ink, color: '#fff', borderRadius: 22, display: 'grid', placeItems: 'center', fontFamily: W.hand, fontSize: 22 }}>↑</Box>
    </Box>

    <BottomNav active="focus" />
  </Phone>
);

// ────────────────────────────────────────────────────────────────
// MOBILE — PROJECT VIEW variants
// ────────────────────────────────────────────────────────────────

const ProjectV1 = () => (
  <Phone>
    <StatusBar />
    <Box style={{ padding: '6px 18px 12px' }}>
      <Box style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Hand size={18} style={{ color: W.ink }}>‹</Hand>
        <Hand size={14} rot={-1} style={{ color: W.mute }}>projects</Hand>
      </Box>
      <Box style={{ fontFamily: W.ui, fontSize: 22, fontWeight: 800, letterSpacing: -0.5, marginTop: 6 }}>
        Website Redesign
      </Box>
      <Box style={{ display: 'flex', gap: 10, marginTop: 6, fontFamily: W.mono, fontSize: 9.5, color: W.mute, letterSpacing: 0.4 }}>
        <span>32 TASKS</span>
        <span>·</span>
        <span>11 DONE</span>
        <span>·</span>
        <span>3 STAGES</span>
      </Box>
      {/* progress bar */}
      <Box style={{ height: 4, background: W.surf, borderRadius: 2, marginTop: 10, overflow: 'hidden' }}>
        <Box style={{ width: '34%', height: '100%', background: W.ink }} />
      </Box>
    </Box>

    <Box style={{ padding: '4px 12px 80px', overflow: 'hidden' }}>
      <Section title="Marketing" count="14">
        <Stage label="Drafting" count="4">
          <Task title="Hero copy v3" pri="R" due="Today" tags={['copy']} compact />
          <Task title="Press release outline" pri="H" due="Fri" compact prog />
        </Stage>
        <Stage label="Review" count="3" last>
          <Task title="Brand voice doc" pri="M" tags={['copy']} compact />
          <Task title="Update FAQ" pri="L" due="Mon" compact done dim />
        </Stage>
      </Section>

      <Section title="Engineering" count="12" />
      <Section title="Design" count="6" collapsed />
    </Box>

    <BottomNav active="projects" />
  </Phone>
);

const ProjectV2 = () => (
  <Phone>
    <StatusBar />
    <Box style={{ padding: '6px 14px 8px' }}>
      <Box style={{
        display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px',
        border: `1px solid ${W.line}`, borderRadius: 8,
        fontFamily: W.ui, fontSize: 12, color: W.ink,
      }}>
        <Hand size={12} style={{ color: W.mute }}>◰</Hand>
        <span>Website Redesign</span>
        <Hand size={12} style={{ color: W.mute, marginLeft: 'auto' }}>▾</Hand>
      </Box>
    </Box>

    {/* horizontal stage chips */}
    <Box style={{ padding: '0 14px', display: 'flex', gap: 6, overflowX: 'hidden', position: 'relative' }}>
      {['All', 'Drafting', 'Review', 'Shipping', 'Backlog'].map((t, i) => (
        <Box key={t} style={{
          padding: '5px 10px', borderRadius: 14,
          fontFamily: W.mono, fontSize: 9.5, fontWeight: 700, letterSpacing: 0.5,
          background: i === 1 ? W.ink : '#fff',
          color: i === 1 ? '#fff' : W.ink,
          border: i === 1 ? 'none' : `1px solid ${W.line}`,
          flexShrink: 0,
        }}>{t.toUpperCase()}</Box>
      ))}
    </Box>

    <Box style={{ padding: '14px 14px 80px', position: 'relative' }}>
      <Anno top={6} rot={-3}>density: cozy</Anno>
      <Box style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <Box style={{ fontFamily: W.ui, fontSize: 11, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase' }}>
          Marketing › Drafting
        </Box>
        <Hand size={12} style={{ color: W.mute }}>4 tasks</Hand>
      </Box>

      <Sketch dashed={false} radius={10}>
        <Task title="Hero copy v3 — three variants" pri="R" due="Today 4:00" tags={['copy', 'launch']} />
        <Task title="Press release outline" pri="H" due="Fri" prog tags={['copy']} />
        <Task title="Newsletter teaser" pri="M" due="Mon" />
        <Task title="Social caption pack (10)" pri="L" tags={['social']} />
      </Sketch>

      <Box style={{ marginTop: 14, fontFamily: W.ui, fontSize: 11, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase', marginBottom: 8 }}>
        Marketing › Review
      </Box>
      <Sketch dashed={false} radius={10}>
        <Task title="Brand voice doc" pri="M" tags={['copy']} />
        <Task title="Update FAQ" pri="L" due="Mon" done dim />
      </Sketch>
    </Box>

    <BottomNav active="projects" />
  </Phone>
);

const ProjectV3 = () => (
  <Phone>
    <StatusBar />
    <Box style={{ padding: '6px 18px 10px', position: 'relative' }}>
      <Anno top={10} rot={-3}>compact / outline</Anno>
      <Box style={{ fontFamily: W.ui, fontSize: 18, fontWeight: 800, letterSpacing: -0.4 }}>Website Redesign</Box>
      <Box style={{ fontFamily: W.mono, fontSize: 9, color: W.mute, letterSpacing: 0.5, marginTop: 2 }}>
        OUTLINE MODE · 32 ITEMS
      </Box>
    </Box>

    <Box style={{ padding: '0 18px 80px', fontFamily: W.ui, fontSize: 12 }}>
      {[
        { d: 0, t: 'Marketing', kind: 'sec', n: 14 },
        { d: 1, t: 'Drafting', kind: 'stage', n: 4 },
        { d: 2, t: 'Hero copy v3', pri: 'R', due: 'Today' },
        { d: 2, t: 'Press release outline', pri: 'H', due: 'Fri', prog: true },
        { d: 2, t: 'Newsletter teaser', pri: 'M' },
        { d: 2, t: 'Social caption pack (10)', pri: 'L' },
        { d: 1, t: 'Review', kind: 'stage', n: 3 },
        { d: 2, t: 'Brand voice doc', pri: 'M' },
        { d: 2, t: 'Update FAQ', pri: 'L', done: true },
        { d: 0, t: 'Engineering', kind: 'sec', n: 12 },
        { d: 1, t: 'API', kind: 'stage', n: 6, collapsed: true },
        { d: 1, t: 'Frontend', kind: 'stage', n: 4, collapsed: true },
        { d: 0, t: 'Design', kind: 'sec', n: 6, collapsed: true },
      ].map((row, i) => {
        const indent = row.d * 14;
        if (row.kind === 'sec') {
          return (
            <Box key={i} style={{
              display: 'flex', alignItems: 'center', gap: 6,
              paddingLeft: indent, paddingTop: 10, paddingBottom: 4,
              borderTop: i ? `1px dashed ${W.line2}` : 'none',
            }}>
              <Hand size={12}>{row.collapsed ? '▸' : '▾'}</Hand>
              <span style={{ fontWeight: 800, letterSpacing: 0.2 }}>{row.t}</span>
              <span style={{ fontFamily: W.mono, fontSize: 9, color: W.mute }}>{row.n}</span>
            </Box>
          );
        }
        if (row.kind === 'stage') {
          return (
            <Box key={i} style={{
              display: 'flex', alignItems: 'center', gap: 6,
              paddingLeft: indent, paddingTop: 6, paddingBottom: 4,
              fontFamily: W.mono, fontSize: 9.5, color: W.ink, fontWeight: 700, letterSpacing: 0.8, textTransform: 'uppercase',
            }}>
              <Hand size={11}>{row.collapsed ? '▸' : '▾'}</Hand>
              <span>{row.t}</span>
              <span style={{ color: W.mute2 }}>· {row.n}</span>
            </Box>
          );
        }
        return (
          <Box key={i} style={{
            display: 'flex', alignItems: 'center', gap: 8,
            paddingLeft: indent, paddingTop: 5, paddingBottom: 5,
            borderBottom: `1px dotted ${W.line2}`,
            opacity: row.done ? 0.4 : 1,
          }}>
            <Box style={{
              width: 12, height: 12, borderRadius: 2, border: `1.25px solid ${W.ink}`,
              background: row.done ? W.ink : row.prog ? `repeating-linear-gradient(45deg, #000 0 1.5px, #fff 1.5px 3px)` : '#fff',
              flexShrink: 0,
            }} />
            <span style={{ flex: 1, textDecoration: row.done ? 'line-through' : 'none' }}>{row.t}</span>
            {row.due && <span style={{ fontFamily: W.mono, fontSize: 9, color: W.mute }}>{row.due}</span>}
            {row.pri && <Pri level={row.pri} />}
          </Box>
        );
      })}
    </Box>

    <BottomNav active="projects" />
  </Phone>
);

// ────────────────────────────────────────────────────────────────
// DESKTOP — three-pane layouts
// ────────────────────────────────────────────────────────────────

const DesktopV1 = () => (
  <Box style={{
    width: 1200, height: 760, background: W.paper,
    border: `1.5px solid ${W.ink}`, borderRadius: 10, overflow: 'hidden',
    display: 'grid', gridTemplateColumns: '220px 1fr 280px', position: 'relative',
    boxShadow: '4px 4px 0 #000', fontFamily: W.ui,
  }}>
    {/* LEFT NAV */}
    <Box style={{ borderRight: `1px solid ${W.line}`, padding: '18px 14px', background: W.surf2 }}>
      <Box style={{ fontFamily: W.ui, fontSize: 16, fontWeight: 800, letterSpacing: -0.3 }}>Tasker</Box>
      <Hand size={13} rot={-1} style={{ color: W.mute }}>workspace · personal</Hand>

      <Box style={{ marginTop: 22 }}>
        {[
          { t: 'Focus',         g: '◉', active: false },
          { t: 'Today briefing', g: '☷', active: false },
          { t: 'Inbox',         g: '✉' },
          { t: 'All tasks',     g: '☰' },
        ].map((it, i) => (
          <Box key={i} style={{
            display: 'flex', alignItems: 'center', gap: 10, padding: '7px 8px',
            fontSize: 13, color: W.ink, borderRadius: 6,
          }}>
            <span style={{ width: 16 }}>{it.g}</span>
            <span>{it.t}</span>
          </Box>
        ))}
      </Box>

      <Box style={{ marginTop: 22 }}>
        <Box style={{ fontFamily: W.mono, fontSize: 9, fontWeight: 700, letterSpacing: 1, color: W.mute, padding: '0 8px 8px' }}>
          PROJECTS
        </Box>
        {[
          { t: 'Website Redesign', n: 32, active: true },
          { t: 'Mobile App v2', n: 18 },
          { t: 'Q3 Hiring', n: 9 },
          { t: 'Personal', n: 14 },
          { t: 'Reading list', n: 23 },
        ].map((p, i) => (
          <Box key={i} style={{
            display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px',
            fontSize: 13, color: p.active ? W.ink : W.ink2, fontWeight: p.active ? 700 : 500,
            background: p.active ? '#fff' : 'transparent',
            border: p.active ? `1px solid ${W.line}` : '1px solid transparent',
            borderRadius: 6, marginBottom: 1,
          }}>
            <span style={{ width: 6, height: 6, borderRadius: 3, background: p.active ? W.ink : W.line, flexShrink: 0 }} />
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.t}</span>
            <span style={{ fontFamily: W.mono, fontSize: 10, color: W.mute2 }}>{p.n}</span>
          </Box>
        ))}
        <Box style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px', fontSize: 12, color: W.mute, marginTop: 4 }}>
          <Hand size={14}>+</Hand>
          <span>New project</span>
        </Box>
      </Box>
    </Box>

    {/* CENTER PANEL */}
    <Box style={{ padding: '20px 28px', overflow: 'hidden', position: 'relative' }}>
      <Anno top={20} rot={-2} side="right">project panel</Anno>
      <Box style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <Box>
          <Hand size={14} rot={-1} style={{ color: W.mute }}>website redesign</Hand>
          <Box style={{ fontSize: 26, fontWeight: 800, letterSpacing: -0.6, marginTop: 2 }}>Website Redesign</Box>
        </Box>
        <Box style={{ display: 'flex', gap: 6 }}>
          {['List', 'Board', 'Outline'].map((t, i) => (
            <Box key={t} style={{
              padding: '5px 10px', borderRadius: 6, fontSize: 11, fontWeight: 600,
              background: i === 0 ? W.ink : '#fff', color: i === 0 ? '#fff' : W.ink,
              border: i === 0 ? 'none' : `1px solid ${W.line}`,
            }}>{t}</Box>
          ))}
          <Box style={{ width: 28, height: 26, border: `1px solid ${W.line}`, borderRadius: 6, display: 'grid', placeItems: 'center' }}>
            <Hand size={13}>⌕</Hand>
          </Box>
        </Box>
      </Box>

      <Box style={{ marginTop: 18, height: 660, overflow: 'hidden' }}>
        <Section title="Marketing" count="14">
          <Stage label="Drafting" count="4">
            <Task title="Hero copy v3 — three variants drafted, pick one" pri="R" due="Today 4:00" tags={['copy', 'launch']} />
            <Task title="Press release outline" pri="H" due="Fri" prog tags={['copy']} />
            <Task title="Newsletter teaser" pri="M" due="Mon" />
          </Stage>
          <Stage label="Review" count="3" last>
            <Task title="Brand voice doc — final pass with Maria" pri="M" tags={['copy']} />
            <Task title="Update FAQ" pri="L" due="Mon" done dim />
          </Stage>
        </Section>

        <Section title="Engineering" count="12">
          <Stage label="API" count="6">
            <Task title="Sessions endpoint — pagination" pri="H" due="Wed" tags={['backend']} />
            <Task title="Rate limiter audit" pri="M" tags={['backend']} />
          </Stage>
          <Stage label="Frontend" count="6" last>
            <Task title="New marketing nav component" pri="M" prog tags={['frontend']} />
          </Stage>
        </Section>

        <Section title="Design" count="6" collapsed />
      </Box>
    </Box>

    {/* RIGHT — IN PROGRESS */}
    <Box style={{ borderLeft: `1px solid ${W.line}`, padding: '20px 18px', background: W.surf2, position: 'relative' }}>
      <Anno top={18} rot={-3}>in-progress sidebar</Anno>
      <Box style={{ fontFamily: W.mono, fontSize: 9.5, fontWeight: 700, letterSpacing: 1, color: W.mute }}>
        IN PROGRESS · 3
      </Box>

      <Sketch dashed={false} radius={10} style={{ marginTop: 12, padding: '12px 12px', background: W.ink, color: '#fff' }}>
        <Box style={{ fontFamily: W.mono, fontSize: 9, color: '#aaa', letterSpacing: 0.6 }}>★ DOING NOW</Box>
        <Box style={{ fontSize: 13, fontWeight: 700, marginTop: 4, lineHeight: 1.3 }}>Finalize landing page hero copy</Box>
        <Box style={{ fontSize: 10, color: '#aaa', marginTop: 4 }}>Website › Marketing › Launch</Box>
        <Box style={{ display: 'flex', gap: 6, marginTop: 10 }}>
          <Box style={{ flex: 1, height: 4, background: '#444', borderRadius: 2, overflow: 'hidden' }}>
            <Box style={{ width: '60%', height: '100%', background: '#fff' }} />
          </Box>
          <span style={{ fontFamily: W.mono, fontSize: 9, color: '#bbb' }}>15 / 25 MIN</span>
        </Box>
      </Sketch>

      {[
        { t: 'Press release outline', proj: 'Marketing', pct: 30 },
        { t: 'New marketing nav', proj: 'Frontend', pct: 75 },
      ].map((it, i) => (
        <Sketch key={i} dashed style={{ marginTop: 10, padding: '10px 12px', background: '#fff' }}>
          <Box style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Box style={{
              width: 12, height: 12, borderRadius: 2, border: `1.25px solid ${W.ink}`,
              background: `repeating-linear-gradient(45deg, #000 0 2px, #fff 2px 4px)`,
            }} />
            <span style={{ fontSize: 12, fontWeight: 600, flex: 1 }}>{it.t}</span>
          </Box>
          <Box style={{ fontFamily: W.mono, fontSize: 9, color: W.mute, marginTop: 3 }}>{it.proj.toUpperCase()}</Box>
          <Box style={{ height: 3, background: W.surf, marginTop: 6, borderRadius: 2, overflow: 'hidden' }}>
            <Box style={{ width: `${it.pct}%`, height: '100%', background: W.ink }} />
          </Box>
        </Sketch>
      ))}

      <Box style={{ marginTop: 28, fontFamily: W.mono, fontSize: 9.5, fontWeight: 700, letterSpacing: 1, color: W.mute, marginBottom: 8 }}>
        QUEUE · NEXT 3
      </Box>
      <Box style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {[
          ['Review brand guidelines', 'H'],
          ['Reply to Maria — pricing', 'M'],
          ['Wireframe billing flow', 'M'],
        ].map(([t, p], i) => (
          <Box key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: `1px dashed ${W.line2}` }}>
            <span style={{ fontFamily: W.mono, fontSize: 10, color: W.mute2 }}>{i + 1}.</span>
            <span style={{ fontSize: 12, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t}</span>
            <Pri level={p} />
          </Box>
        ))}
      </Box>

      {/* AI briefing nudge */}
      <Sketch dashed style={{ marginTop: 22, padding: '12px 12px', background: '#fff' }}>
        <Box style={{ fontFamily: W.mono, fontSize: 9, fontWeight: 700, letterSpacing: 0.8, color: W.ink }}>
          ✦ DAILY BRIEFING
        </Box>
        <Box style={{ fontFamily: W.hand, fontSize: 15, color: W.ink, marginTop: 4, lineHeight: 1.3 }}>
          You have 3 must-dos today. Hero copy is blocking 4 others — start there.
        </Box>
        <Box style={{ marginTop: 8, fontSize: 11, fontWeight: 700, color: W.ink, textDecoration: 'underline' }}>
          Read full briefing →
        </Box>
      </Sketch>
    </Box>
  </Box>
);

const DesktopV2 = () => (
  <Box style={{
    width: 1200, height: 760, background: W.paper,
    border: `1.5px solid ${W.ink}`, borderRadius: 10, overflow: 'hidden',
    display: 'grid', gridTemplateColumns: '64px 1fr 320px', position: 'relative',
    boxShadow: '4px 4px 0 #000', fontFamily: W.ui,
  }}>
    {/* skinny rail */}
    <Box style={{ borderRight: `1px solid ${W.line}`, background: W.ink, color: '#fff', padding: '18px 0', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14 }}>
      <Box style={{ fontFamily: W.ui, fontWeight: 800, fontSize: 18 }}>T.</Box>
      <Box style={{ width: 32, height: 1, background: '#444', margin: '4px 0' }} />
      {['◉', '☷', '✉', '☰'].map((g, i) => (
        <Box key={i} style={{
          width: 36, height: 36, borderRadius: 8,
          background: i === 0 ? '#fff' : 'transparent',
          color: i === 0 ? W.ink : '#fff',
          display: 'grid', placeItems: 'center', fontSize: 16,
        }}>{g}</Box>
      ))}
      <Box style={{ flex: 1 }} />
      {['W', 'M', 'Q', 'P'].map((g, i) => (
        <Box key={i} style={{
          width: 32, height: 32, borderRadius: 16,
          border: `1px solid #444`, color: '#ddd',
          display: 'grid', placeItems: 'center', fontSize: 11, fontWeight: 700,
        }}>{g}</Box>
      ))}
    </Box>

    {/* CENTER — focus tab */}
    <Box style={{ padding: '24px 36px', overflow: 'hidden', position: 'relative' }}>
      <Anno top={24} rot={-2} side="right">focus, desktop scale</Anno>
      <Box style={{ fontSize: 12, color: W.mute, fontFamily: W.mono, letterSpacing: 0.5 }}>THURSDAY · MAY 8 · 9:41 AM</Box>
      <Box style={{ fontSize: 32, fontWeight: 800, letterSpacing: -0.8, marginTop: 4 }}>Good morning, Sam.</Box>
      <Hand size={20} rot={-1} style={{ color: W.mute, marginTop: 4 }}>3 must-do · 5 stretch · 1 rush</Hand>

      {/* hero */}
      <Sketch dashed={false} radius={14} style={{ marginTop: 22, padding: '20px 24px', background: W.ink, color: '#fff', boxShadow: '4px 4px 0 #cfcfcf' }}>
        <Box style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Hand size={15} style={{ color: '#bbb' }}>★ AI ranks this first because →</Hand>
          <span style={{ fontFamily: W.mono, fontSize: 9.5, color: '#bbb', marginLeft: 'auto', letterSpacing: 0.6 }}>4 BLOCKED · DUE 4PM</span>
        </Box>
        <Box style={{ fontSize: 24, fontWeight: 700, marginTop: 8 }}>Finalize landing page hero copy</Box>
        <Box style={{ fontSize: 12, color: '#aaa', marginTop: 4 }}>Website Redesign · Marketing · Launch</Box>
        <Box style={{ display: 'flex', gap: 8, marginTop: 18 }}>
          <Box style={{ padding: '8px 18px', background: '#fff', color: '#000', fontSize: 12, fontWeight: 700, borderRadius: 6 }}>Start focus session</Box>
          <Box style={{ padding: '8px 14px', border: '1px solid #555', color: '#fff', fontSize: 12, borderRadius: 6 }}>Open task</Box>
          <Box style={{ padding: '8px 14px', border: '1px solid #555', color: '#fff', fontSize: 12, borderRadius: 6 }}>Skip</Box>
        </Box>
      </Sketch>

      {/* queue */}
      <Box style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginTop: 24 }}>
        <Box style={{ fontFamily: W.mono, fontSize: 10, fontWeight: 700, letterSpacing: 1, color: W.mute }}>UP NEXT · QUEUE</Box>
        <Hand size={13} rot={-1} style={{ color: W.mute2 }}>tap to reorder</Hand>
      </Box>
      <Sketch dashed={false} radius={10} style={{ marginTop: 8 }}>
        <Task title="Review brand guidelines doc — share notes with team" pri="H" due="Today" tags={['copy']} />
        <Task title="Reply to Maria re: pricing tier breakdown" pri="M" due="Tomorrow" />
        <Task title="Wireframe mobile billing flow — 3 variants" pri="M" due="Fri" tags={['design']} />
        <Task title="Daily wrap-up + tomorrow plan" pri="L" />
      </Sketch>
    </Box>

    {/* RIGHT — in progress */}
    <Box style={{ borderLeft: `1px solid ${W.line}`, padding: '24px 20px', background: W.surf2, position: 'relative' }}>
      <Box style={{ fontFamily: W.mono, fontSize: 10, fontWeight: 700, letterSpacing: 1, color: W.mute }}>BRIEFING</Box>
      <Sketch dashed style={{ marginTop: 8, padding: '14px 14px', background: '#fff' }}>
        <Box style={{ fontFamily: W.hand, fontSize: 17, color: W.ink, lineHeight: 1.35 }}>
          Today is heavy on copy. Hero blocks 4 downstream tasks — clear it before noon. Maria's reply needs you, not a meeting.
        </Box>
      </Sketch>

      <Box style={{ fontFamily: W.mono, fontSize: 10, fontWeight: 700, letterSpacing: 1, color: W.mute, marginTop: 22 }}>
        IN PROGRESS · 3
      </Box>
      {[
        { t: 'Hero copy v3', proj: 'Website › Marketing', pct: 60 },
        { t: 'Press release outline', proj: 'Website › Marketing', pct: 30 },
        { t: 'New marketing nav', proj: 'Website › Frontend', pct: 75 },
      ].map((it, i) => (
        <Sketch key={i} dashed style={{ marginTop: 10, padding: '12px 12px', background: '#fff' }}>
          <Box style={{ fontSize: 13, fontWeight: 700, lineHeight: 1.25 }}>{it.t}</Box>
          <Box style={{ fontFamily: W.mono, fontSize: 9.5, color: W.mute, marginTop: 4, letterSpacing: 0.4 }}>{it.proj.toUpperCase()}</Box>
          <Box style={{ height: 3, background: W.surf, marginTop: 8, borderRadius: 2 }}>
            <Box style={{ width: `${it.pct}%`, height: '100%', background: W.ink }} />
          </Box>
        </Sketch>
      ))}
    </Box>
  </Box>
);

// ────────────────────────────────────────────────────────────────
// COMPONENT SHEET
// ────────────────────────────────────────────────────────────────

const ComponentSheet = () => (
  <Box style={{
    width: 880, height: 760, background: W.paper, padding: 28,
    border: `1.5px solid ${W.ink}`, borderRadius: 10,
    boxShadow: '4px 4px 0 #000', fontFamily: W.ui, overflow: 'hidden', position: 'relative',
  }}>
    <Hand size={26} rot={-1}>component sheet</Hand>
    <Box style={{ fontFamily: W.mono, fontSize: 10, color: W.mute, marginTop: 4, letterSpacing: 0.5 }}>
      KEY UI · GREYSCALE ONLY
    </Box>

    <Box style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 22, marginTop: 22 }}>
      {/* priority chips */}
      <Box>
        <Box style={{ fontFamily: W.mono, fontSize: 10, fontWeight: 700, letterSpacing: 1, color: W.mute, marginBottom: 8 }}>PRIORITY CHIPS</Box>
        <Sketch dashed style={{ padding: 14, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <Pri level="R" /><Pri level="H" /><Pri level="M" /><Pri level="L" />
        </Sketch>
        <Hand size={14} rot={-1} style={{ color: W.mute, marginTop: 6, display: 'block' }}>
          fill density encodes weight — solid black = rush, dashed outline = low
        </Hand>
      </Box>

      {/* task item states */}
      <Box>
        <Box style={{ fontFamily: W.mono, fontSize: 10, fontWeight: 700, letterSpacing: 1, color: W.mute, marginBottom: 8 }}>TASK ITEM · STATES</Box>
        <Sketch dashed={false} radius={8}>
          <Task title="Default" pri="M" due="Fri" tags={['copy']} compact />
          <Task title="In progress" pri="H" prog due="Today" compact />
          <Task title="Done" pri="L" done dim compact />
        </Sketch>
      </Box>

      {/* section card */}
      <Box>
        <Box style={{ fontFamily: W.mono, fontSize: 10, fontWeight: 700, letterSpacing: 1, color: W.mute, marginBottom: 8 }}>SECTION CARD</Box>
        <Section title="Marketing" count="14">
          <Box style={{ padding: '12px 14px', fontFamily: W.hand, fontSize: 14, color: W.mute }}>
            … child stages live here
          </Box>
        </Section>
      </Box>

      {/* stage group */}
      <Box>
        <Box style={{ fontFamily: W.mono, fontSize: 10, fontWeight: 700, letterSpacing: 1, color: W.mute, marginBottom: 8 }}>STAGE GROUP</Box>
        <Sketch dashed={false} radius={8}>
          <Stage label="Drafting" count="4">
            <Task title="Hero copy v3" pri="R" compact />
          </Stage>
          <Stage label="Review" count="3" last>
            <Task title="Brand voice doc" pri="M" compact />
          </Stage>
        </Sketch>
      </Box>

      {/* bottom nav */}
      <Box style={{ gridColumn: '1 / -1' }}>
        <Box style={{ fontFamily: W.mono, fontSize: 10, fontWeight: 700, letterSpacing: 1, color: W.mute, marginBottom: 8 }}>BOTTOM NAV BAR · MOBILE</Box>
        <Box style={{ position: 'relative', height: 80, border: `1px solid ${W.line}`, borderRadius: 10, overflow: 'hidden', background: W.paper }}>
          <Box style={{ position: 'absolute', inset: 0 }}>
            <Box style={{ position: 'absolute', left: 0, right: 0, top: 0, padding: '10px 16px', fontFamily: W.hand, fontSize: 14, color: W.mute2 }}>
              … screen content above …
            </Box>
            <BottomNav active="focus" />
          </Box>
        </Box>
        <Hand size={14} rot={-1} style={{ color: W.mute, marginTop: 6, display: 'block' }}>
          5 tabs · active gets a 2px black top-rule + ink label
        </Hand>
      </Box>
    </Box>
  </Box>
);

// ────────────────────────────────────────────────────────────────
// CANVAS LAYOUT
// ────────────────────────────────────────────────────────────────

function App() {
  return (
    <DesignCanvas>
      <DCSection id="focus" title="Mobile · Focus tab" subtitle="Three approaches to 'Do This Now'">
        <DCArtboard id="focus-1" label="A · Hero card + queue"   width={320} height={640}><FocusV1 /></DCArtboard>
        <DCArtboard id="focus-2" label="B · Day timeline"        width={320} height={640}><FocusV2 /></DCArtboard>
        <DCArtboard id="focus-3" label="C · Swipe deck"          width={320} height={640}><FocusV3 /></DCArtboard>
      </DCSection>

      <DCSection id="project" title="Mobile · Project view" subtitle="Sections + stages + tasks">
        <DCArtboard id="proj-1" label="A · Stacked sections" width={320} height={640}><ProjectV1 /></DCArtboard>
        <DCArtboard id="proj-2" label="B · Stage filter chips" width={320} height={640}><ProjectV2 /></DCArtboard>
        <DCArtboard id="proj-3" label="C · Outline mode"     width={320} height={640}><ProjectV3 /></DCArtboard>
      </DCSection>

      <DCSection id="desktop" title="Desktop · Three-pane" subtitle="Sidebar nav · project · in-progress rail">
        <DCArtboard id="dt-1" label="A · Roomy sidebar (project view)" width={1200} height={760}><DesktopV1 /></DCArtboard>
        <DCArtboard id="dt-2" label="B · Skinny rail (focus view)"     width={1200} height={760}><DesktopV2 /></DCArtboard>
      </DCSection>

      <DCSection id="components" title="Components" subtitle="Key UI atoms + bottom nav">
        <DCArtboard id="comp-1" label="System sheet" width={880} height={760}><ComponentSheet /></DCArtboard>
      </DCSection>
    </DesignCanvas>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
