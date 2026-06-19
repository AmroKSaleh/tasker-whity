-- TDE-287: verifiable contract gate (finishes TDE-203's unrealized "non-bypassable gate").
-- name_flow now refuses to finalize a flow whose internal handoffs lack non-trivial,
-- human-blessed contracts. An author may override with bypass:true; the override is
-- recorded here so a gate-bypassed flow is VISIBLY weak rather than silently so.

alter table flows add column if not exists gate_bypassed boolean not null default false;
alter table flows add column if not exists gate_bypass_reason text;
alter table flows add column if not exists gate_bypassed_at timestamptz;
