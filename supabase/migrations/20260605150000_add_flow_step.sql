-- TDE-216: flow_step — persistent step ordinal within a named flow
-- Assigned by name_flow via topo-sort of the I/O graph.
-- Displayed as "Step N · TDE-103" in all flow tools.

alter table tasks add column if not exists flow_step integer;

create index if not exists tasks_flow_step_idx on tasks(flow_id, flow_step)
  where flow_id is not null;
