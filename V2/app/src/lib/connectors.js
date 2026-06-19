import { GitBranch, Calendar, HardDrive, Mail, ListChecks, MessageSquare } from 'lucide-react'
import { GOOGLE_SCOPES } from './google'

// 3rd-party connector registry. `kind` drives how ConnectorsSection renders/wires it:
//   'github' | 'gcal' — hook-backed live providers (existing flows)
//   'google'          — shared Google connection (google.js refresh-token flow); needs `scope`
//   'soon'            — not built yet
// `slice` = the Tasker-relevant view we surface — never a full app client
// (see KB "Connectors: scoped Tasker-relevant panels, never full app clients").
export const CONNECTORS = [
  { id: 'github',          label: 'GitHub',          icon: GitBranch,     kind: 'github', slice: 'Import issues & repos as tasks.' },
  { id: 'google_calendar', label: 'Google Calendar', icon: Calendar,      kind: 'gcal',   slice: 'Due dates sync to your calendar; events show in Today.' },
  { id: 'google_drive',    label: 'Google Drive',    icon: HardDrive,     kind: 'google', scope: GOOGLE_SCOPES.drive, slice: 'Attach Drive files as task artifacts.' },
  { id: 'gmail',           label: 'Gmail',           icon: Mail,          kind: 'google', scope: GOOGLE_SCOPES.gmail, slice: 'Turn relevant emails into structured tasks.', panelRoute: '/connectors/gmail' },
  { id: 'google_tasks',    label: 'Google Tasks',    icon: ListChecks,    kind: 'google', scope: GOOGLE_SCOPES.tasks, slice: 'Two-way sync with Google Tasks.' },
  { id: 'slack',           label: 'Slack',           icon: MessageSquare, kind: 'soon',   slice: 'Import messages as tasks; post verifiable progress back.' },
]
