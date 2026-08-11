# Connectors: scoped Tasker-relevant panels, never full app clients (+ judicious MCP re-exposure)

_KB entry · source: agent · READ-ONLY mirror (edit via create_kb_entry/update_kb_entry over MCP)._

DECIDED 2026-06-19. How 3rd-party app connectors work in Tasker:

(a) CONNECT via a Settings → "Connectors" page (OAuth). Mirror the existing GitHub/Google token-storage pattern — don't invent a new hub mechanism.

(b) SURFACE as a sidebar icon that opens a SCOPED panel showing ONLY the slice of the app relevant to Tasker's work — rendered in Tasker's own UI. NEVER a full app client. Rebuilding Gmail/Slack inside Tasker = the destination trap (always worse than the real app, huge maintenance, off the execution-layer/cockpit thesis). The slice varies by app:
  - Gmail → threads you can convert to tasks / emails linked to tasks (NOT a full inbox).
  - Calendar → events near task due dates + create-event-from-task.
  - Google Tasks → two-way sync with Tasker tasks.
  - Drive → attach files as task artifacts.
  - Slack → post updates / pull a message into a task.

(c) MCP RE-EXPOSURE (connect-once-in-Tasker → tools available to every MCP host: CC/Cursor/Codex). Apply JUDICIOUSLY — value is PROVIDER-DEPENDENT: LOW for Google (the agent already has its own Gmail/Cal/Drive connectors — re-exposing duplicates them), HIGH for Slack and less-common/event-driven providers the agent lacks.

SECURITY: holding 3rd-party OAuth tokens makes Tasker a credential custodian + confused-deputy surface — encrypt at rest, request minimal scopes, clean revocation, and the MCP must act only as the token's owning user.

DIFFERENTIATION (don't skip): the pipe itself (import message→task, post status) is commodity — every incumbent does it. Tasker's edge is AFTER the pipe: the agent structures imports into contract/flow tasks and reports VERIFIABLE progress (judge/contracts), not a checkbox echo. See the Slack strategy in TDE-286.
