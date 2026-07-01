-- TDE-324: Task relay.
-- A relayed task carries a curated rationale layer authored when the task was created/handed
-- off, so the assignee (human or AI) can act without a follow-up round-trip to the creator.
-- Presence of relay_context = the task is a relay task; the text holds the curated notes
-- (free-text recipient, decisions, rejected approaches & why, intent, open questions, watch-outs).
-- Deliberately ONE nullable column — it is both the flag and the payload. Distinct from `detail`
-- (the distilled self-contained context) so relay does not muddy TDE-305's cold-reader contract.
alter table public.tasks add column if not exists relay_context text;

comment on column public.tasks.relay_context is
  'TDE-324 task relay: curated rationale layer for a handed-off task (decisions, rejected approaches & why, intent, free-text recipient, open questions). Non-null => relay task. Distinct from detail.';
