-- Durable gate history (TDE-818). The append-only record of WHAT CHANGED on a task's
-- contract / gate / review state — the missing half of the wedge claim "durable,
-- human-shared, quality-gated state that persists across sessions, agents, and people".
--
-- THE PROBLEM THIS FIXES: every gate mutation was previously an in-place overwrite.
-- confirm_contract wrote three fields onto tasks.output and a later set_task_output
-- erased that a human ever blessed it; submit_task_review overwrote review_verdict so
-- attempt 1's critique was gone by attempt 2; submit_validation_result keyed ledgers per
-- EDGE not per ATTEMPT, so retry_count could report 3 failures with all 3 bodies lost.
-- get_flow_audit is named "audit" but renders current mutable JSONB — a snapshot, not a log.
--
-- WHY A NEW TABLE rather than extending agent_activities (the other append-only ledger):
--   1. agent_activities.session_id is NOT NULL → every row needs an agent_sessions parent.
--      A human confirming a contract in the web app has no agent session; synthesising one
--      per human click would corrupt what a "session" means.
--   2. get_task_activity DERIVES session lifecycle (active/awaiting_input/error/stale) from
--      the LAST entry's type. Injecting structural audit rows would make a contract edit the
--      "last entry" and break that derivation.
--   3. Its type CHECK is narrative (progress/action/question/result/error) and body is text;
--      audit needs structured before/after JSONB.
-- TDE-375's locked spec already intended "write actor into ledger entries + a task-events
-- log" — the actor half shipped, this is the log it named.
--
-- ADDITIVE only. The MCP runs as service role and bypasses RLS; the web app runs under the
-- user JWT and relies on these policies. can_access_task() already exists (20260705120000).

create table if not exists task_events (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references tasks(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  -- What happened. Deliberately coarse: one kind per gate ceremony, so the log stays
  -- readable and queryable (TDE-378's filter grammar will facet on this).
  kind text not null check (kind in (
    'contract_set',           -- set_task_output / derive_output_contract(apply)
    'contract_cleared',       -- clear_task_output
    'contract_confirmed',     -- confirm_contract (the human blessing)
    'review_bar_frozen',      -- enable_task_review
    'review_bar_cleared',     -- disable_task_review
    'review_submitted',       -- submit_task_review (ONE ROW PER ATTEMPT)
    'validation_submitted',   -- submit_validation_result (ONE ROW PER ATTEMPT, per edge)
    'fields_changed'          -- update_task field patch
  )),
  -- Which surface the change landed on.
  entity text not null check (entity in ('output_contract','input_contract','review','validation','task')),
  actor text,                                    -- token-derived agent label (TDE-375) or null for human/web
  summary text not null,                         -- one-line human-readable account
  before jsonb,                                  -- prior state, THE part that used to be destroyed
  after jsonb,                                   -- new state
  meta jsonb,                                    -- flags: erased_confirmation, overwrote_frozen_bar, attempt, edge_key, via
  created_at timestamptz not null default now()
);

create index if not exists task_events_task_idx on task_events(task_id, created_at desc);
create index if not exists task_events_kind_idx on task_events(task_id, kind, created_at desc);
create index if not exists task_events_user_idx on task_events(user_id, created_at desc);
-- Partial index for the query that motivates the whole table: "was a human confirmation
-- ever silently erased on this task?"
create index if not exists task_events_erased_confirmation_idx on task_events(task_id)
  where (meta->>'erased_confirmation') = 'true';

-- Immutability. An audit log that can be edited is not an audit log. The MCP is service
-- role (bypasses RLS), so append-only cannot rely on policies alone — a trigger hard-rejects
-- UPDATE. DELETE is intentionally NOT trigger-blocked so `on delete cascade` from tasks still
-- works; the web app is blocked from deleting by the absence of a delete policy, and no MCP
-- tool deletes events. (Same reasoning as agent_activities, 20260711120000.)
create or replace function reject_task_event_update()
returns trigger language plpgsql as $$
begin
  raise exception 'task_events is append-only (TDE-818): UPDATE is not allowed';
end;
$$;
drop trigger if exists task_events_no_update on task_events;
create trigger task_events_no_update before update on task_events
  for each row execute function reject_task_event_update();

-- RLS: owner OR org-granted access to the parent task (mirrors agent_activities).
alter table task_events enable row level security;
drop policy if exists "task_events access" on task_events;
create policy "task_events access" on task_events for select
  using (user_id = auth.uid() or can_access_task(task_id));
drop policy if exists "task_events insert" on task_events;
create policy "task_events insert" on task_events for insert
  with check (user_id = auth.uid() or can_access_task(task_id));
-- (no update/delete policies — immutable; the trigger also hard-blocks UPDATE)

-- Realtime so the web inspector can render gate history live as it lands.
alter publication supabase_realtime add table task_events;
