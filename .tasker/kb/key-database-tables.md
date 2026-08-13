# Key Database Tables

_KB entry · source: user · READ-ONLY mirror (edit via create_kb_entry/update_kb_entry over MCP)._

# Key Database Tables

Orientation, not a schema dump — load-bearing columns only. Derived 2026-08-07 from the 77 migrations plus every `.from('…')` call in `supabase/functions/` and `app/src/` (40 tables in live use). See the caveat at the bottom.

## Core hierarchy
Project → Section → Group → Task → Milestone.

- **projects** — id, name, slug, **prefix** (short-ID handle, e.g. `TDE`), context (jsonb), github_repo, environment_id, active_phase_id, local_mode, is_deleted, deleted_at, user_id
- **sections** — id, project_id, name, sort_order
- **groups** — id, project_id, section_id, name, slug, sort_order
- **tasks** — id, project_id, section_id, group_id, phase_id, flow_id, user_id, text, detail, **current_state**, priority, status, due_date, short_id, sort_order, input/output (jsonb I/O contracts), review_enabled, review_bar, agent_ready, agent_proposal, agent_proposal_confirmed, executor, delegated_to, relay_context, tags, duplicate_of, pinned, intake_source, github_issue_number, completed_at, updated_at, local_rev, **is_deleted**, deleted_at
- **MILESTONES ARE NOT A TABLE.** They live in `task_discussions.steps` / `checked_steps` (jsonb arrays) and are mutated by SQL functions `append_milestone`, `set_milestone_checked`, `delete_milestone_at` — added to stop read-modify-write races. Do not try to query a `milestones` table; it does not exist.
- **task_discussions** — id, task_id, user_id, steps (jsonb), checked_steps (bool array), messages (jsonb)
- **task_events** — durable per-task change ledger (TDE-818/819). What gate history reads.
- **task_statuses / project_statuses** — custom statuses beyond pending/in_progress/done

## ⚠ Soft delete
`tasks`, `projects` and `flows` carry `is_deleted` + `deleted_at`. Deletes are SOFT — the row keeps its section_id/group_id/phase_id/project_id. A pg_cron job purges after 7 days. **Every query that counts, groups or lists must filter `is_deleted`** or it silently counts recycle-binned rows. This caused TDE-882 across 13 read sites; see the KB entry on soft delete + unfiltered tallies.

## Flows
- **flows** — id, project_id, name, short_id, context, step_list_open, is_deleted
- **flow_instructions / flow_knowledge** — per-flow IS and KB
- **flow_templates / flow_template_steps** — saved reusable flow shapes

Flow membership is `tasks.flow_id`; step order is derived from the I/O edges in `tasks.input`/`tasks.output`, not a column. Flow steps are deliberately excluded from board and section tallies (TDE-320).

## Environments, Organizations, RBAC
- **environments** — id, name, sort_order, color, user_id, **org_id** (null = personal). Dual-owned: personal envs have user_id, org envs have org_id.
- **organizations** — id, name, owner_user_id
- **organization_members** — membership + role
- **organization_invitations** — copy-link invite → accept → membership (no email sending; copy-link is intentional)
- **environment_grants** — per-environment access grants; grant = full access in v1

Shipped and live in the web app, but **the MCP exposes no org tooling** — org-owned projects are currently unreachable from MCP. Phase 2.

## Phases
- **phases** — condition-bounded project stages, nullable; `projects.active_phase_id` points at the current one, `tasks.phase_id` assigns. Unphased is a legitimate permanent state, not a backlog to drain.

## Agent-native layer
- **agent_sessions / agent_activities** — typed per-task activity log with derived lifecycle state
- **task_guidance** — human guidance left on a task, consumed across sessions
- **webhooks / webhook_deliveries** — outbound task/flow/review events + delivery ledger
- **mcp_context_primed** — first-touch-per-session tracking that powers get_task context tiering (~93% cut on repeat calls). Own-row RLS policies required — a scoped anon-key client silently failed reads/writes before they were added (TDE-870).
- **mcp_error_logs** — resolveProject/tool failures, with raw params

## Local Mode
- **local_device_tokens** — project-scoped tokens for the file watcher
- **local_id_leases** — reserved short-ID ranges so offline creation cannot collide
- **local_tombstones** — deletes propagated to `.tasker/` checkouts

## Connectors and intake
- **intake_jobs** — Conductor items per connector, with lifecycle state and provenance
- **oauth_clients / oauth_codes / oauth_tokens** — Tasker as an OAuth2 provider (claude.ai integration)
- **user_settings** — github_access_token, google refresh tokens + connected scopes, connector emails, default_project_id, active_environment_id, theme, drive folder ids

## Knowledge, instructions, drafts
- **project_knowledge** — the KB (this entry lives here)
- **project_instructions** — per-project Instruction Sets; **default_instructions** — personal/org defaults seeded into new projects
- **project_drafts** — bootstrap interview state
- **project_updates** — published project updates with server-computed delta

## Auth
- **user_api_keys** — id, user_id, key_hash, name, last_used_at. MCP keys are `tsk_…`, generated in Settings → API Keys and stored **hashed**. Never paste a raw key anywhere it persists — one ended up in this very KB and had to be removed (TDE-846).

---
**Caveat on provenance:** this was derived from migrations and code usage, not from `information_schema`. Reading the live schema needs Docker (for `supabase db dump`) or a service-role key, neither of which was available. A table dropped or renamed without a migration would not be caught here.

