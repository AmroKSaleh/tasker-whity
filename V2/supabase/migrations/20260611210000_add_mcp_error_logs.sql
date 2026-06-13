create table if not exists mcp_error_logs (
  id         uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  user_id    uuid references auth.users(id) on delete set null,
  tool_name  text,
  raw_params jsonb,
  error_msg  text
);

create index if not exists mcp_error_logs_created_at_idx on mcp_error_logs(created_at desc);

alter table mcp_error_logs enable row level security;

-- Only the service role can insert (edge function uses service key)
-- Users can read their own logs
create policy "Users read own mcp error logs"
  on mcp_error_logs for select
  using (user_id = auth.uid());
