import { GitBranch, Calendar, HardDrive, Mail, ListChecks, MessageSquare } from 'lucide-react'

// 3rd-party connector registry. Metadata only — connect/disconnect need React hooks,
// so they live in ConnectorsSection. See KB "Connectors: scoped Tasker-relevant panels,
// never full app clients".
//   status: 'live'  — wired now (hook-backed in ConnectorsSection)
//           'setup' — built but needs Google Cloud setup + TDE-245 deploy before it works
//           'soon'  — not built yet
//   slice:  the Tasker-relevant view we surface — NEVER a full app client.
export const CONNECTORS = [
  { id: 'github',          label: 'GitHub',          icon: GitBranch,  status: 'live',  slice: 'Import issues & repos as tasks.' },
  { id: 'google_calendar', label: 'Google Calendar', icon: Calendar,   status: 'live',  slice: 'Due dates sync to your calendar; events show in Today.' },
  { id: 'google_drive',    label: 'Google Drive',    icon: HardDrive,  status: 'setup', slice: 'Attach Drive files as task artifacts.' },
  { id: 'gmail',           label: 'Gmail',           icon: Mail,       status: 'setup', slice: 'Turn relevant emails into structured tasks.' },
  { id: 'google_tasks',    label: 'Google Tasks',    icon: ListChecks, status: 'setup', slice: 'Two-way sync with Google Tasks.' },
  { id: 'slack',           label: 'Slack',           icon: MessageSquare, status: 'soon',  slice: 'Import messages as tasks; post verifiable progress back.' },
]

export const STATUS_NOTE = {
  setup: 'Needs Google connected (admin setup pending).',
  soon: 'Coming soon.',
}
