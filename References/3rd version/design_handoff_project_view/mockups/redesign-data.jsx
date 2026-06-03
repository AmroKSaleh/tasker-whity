// Realistic project data for the mockups — "Q2 Launch Plan"

const SECTIONS = [
  {
    id: 'design',
    name: 'Design',
    done: 4, total: 9,
    ungrouped: [
      { id: 'd-u1', title: 'Decide on column gap — 12 or 16?', priority: 'low', tags: ['decision'] },
    ],
    lanes: [
      {
        name: 'Research',
        tasks: [
          { id: 'd-1', title: 'Watch 3 users build a project end-to-end', done: true },
          { id: 'd-2', title: 'Interview Maya about her stage workflow', done: true },
          { id: 'd-3', title: 'Pull screenshots of every empty state', priority: 'low' },
        ],
      },
      {
        name: 'Specs',
        tasks: [
          { id: 'd-4', title: 'Project view redesign — annotated mockups', priority: 'high', due: 'Today', today: true },
          { id: 'd-5', title: 'Audit empty-states across project & focus screens', inProgress: true, due: 'Fri', priority: 'med' },
          { id: 'd-6', title: 'Mobile bottom sheet · drag-to-dismiss spec', priority: 'med', due: 'Mon' },
        ],
      },
      {
        name: 'Handoff',
        tasks: [
          { id: 'd-7', title: 'Token doc — write up the warm-neutral system', priority: 'low' },
        ],
      },
    ],
  },
  {
    id: 'api',
    name: 'API · Backend',
    done: 3, total: 11,
    ungrouped: [],
    lanes: [
      {
        name: 'Hardening',
        tasks: [
          { id: 'a-1', title: 'Wire up rate-limiting on the /generate endpoint', inProgress: true, priority: 'high', due: 'Today', today: true, tags: ['beta'] },
          { id: 'a-2', title: 'Add request-id propagation through edge → Supabase', priority: 'high' },
          { id: 'a-3', title: 'Fix the off-by-one in project-progress aggregation', priority: 'rush', due: 'Yesterday', overdue: true },
        ],
      },
      {
        name: 'AI surfaces',
        tasks: [
          { id: 'a-4', title: 'Switch chat generation to streaming responses', priority: 'high', due: 'Wed' },
          { id: 'a-5', title: 'Document the AI task-parser response shape', inProgress: true },
          { id: 'a-6', title: 'Cache briefing output for 10 min per project', priority: 'med' },
        ],
      },
      {
        name: 'Done',
        tasks: [
          { id: 'a-7', title: 'Migrate to Supabase realtime v2', done: true },
          { id: 'a-8', title: 'Move secrets out of .env.local', done: true },
          { id: 'a-9', title: 'Set up structured logs via Logtail', done: true },
        ],
      },
    ],
  },
  {
    id: 'web',
    name: 'Web App',
    done: 5, total: 14,
    ungrouped: [
      { id: 'w-u1', title: 'Fix the keyboard trap in Focus mode discuss sheet', priority: 'rush', due: 'Today', today: true },
      { id: 'w-u2', title: 'Sentry alert: stale auth token after Magic Link refresh', priority: 'high' },
    ],
    lanes: [
      {
        name: 'Project view',
        tasks: [
          { id: 'w-1', title: 'Horizontal column scroller — touch + shift-wheel', priority: 'high', due: 'Wed' },
          { id: 'w-2', title: 'Section drag-and-drop via header @dnd-kit', priority: 'high' },
          { id: 'w-3', title: 'Task detail panel — slide-in transition, focus trap', priority: 'med', due: 'Thu' },
          { id: 'w-4', title: 'Per-column virtualization above 80 tasks', priority: 'low' },
        ],
      },
      {
        name: 'Mobile',
        tasks: [
          { id: 'w-5', title: 'Bottom sheet for task detail + drag-to-dismiss', priority: 'high', due: 'Fri' },
          { id: 'w-6', title: 'Floating in-progress FAB → bottom sheet', priority: 'med' },
          { id: 'w-7', title: 'Snap-scroll column dots indicator', priority: 'low' },
        ],
      },
    ],
  },
  {
    id: 'marketing',
    name: 'Marketing',
    done: 1, total: 8,
    ungrouped: [],
    lanes: [
      {
        name: 'Launch',
        tasks: [
          { id: 'm-1', title: 'Draft launch email v2 — focus mode angle', inProgress: true, priority: 'high', due: 'Tue' },
          { id: 'm-2', title: 'Record 30s teaser of horizontal column scroll', priority: 'med', due: 'Thu' },
          { id: 'm-3', title: 'Update homepage hero screenshot', priority: 'med' },
        ],
      },
      {
        name: 'Outreach',
        tasks: [
          { id: 'm-4', title: 'Pitch 5 productivity-focused newsletters', priority: 'low' },
          { id: 'm-5', title: 'Reply to Patrick about the case study', priority: 'med', due: 'Mon' },
        ],
      },
    ],
  },
  {
    id: 'qa',
    name: 'QA · Polish',
    done: 0, total: 0,
    ungrouped: [],
    lanes: [],
    empty: true,
  },
];

window.TASKER_DATA = { SECTIONS };
