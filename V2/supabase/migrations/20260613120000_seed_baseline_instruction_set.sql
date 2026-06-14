-- TDE-193: default Instruction Set for new projects ("baseline + AI-proposed").
-- An AFTER INSERT trigger on `projects` seeds a baseline IS so early sessions are
-- guided no matter how the project was created (MCP create_project, manual UI,
-- AI generation, GitHub import) — one source of truth for all paths.
--
-- The "AI-proposed" half lives in the MCP create_project response, which nudges the
-- assistant to propose project-specific IS additions for the user to confirm.
--
-- SECURITY DEFINER so the insert succeeds on every path: the MCP uses the service
-- key (RLS bypassed anyway), and direct app inserts run as the user — definer rights
-- keep the trigger insert working regardless of the project_instructions RLS policy.
-- Only fires for NEW projects; existing projects are unaffected.

create or replace function seed_baseline_instructions()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into project_instructions (project_id, user_id, title, content, universal)
  values
    (
      new.id,
      new.user_id,
      'Task hygiene',
      $md$- Refer to tasks by their short ID (e.g. ABC-12), never UUIDs. Don't renumber tasks — the app handles ordering.
- When listing several tasks, group them by section.
- Set a task to in_progress when you start it; mark it done only when the work is genuinely and verifiably complete — otherwise leave it in_progress.$md$,
      true
    ),
    (
      new.id,
      new.user_id,
      'Working preferences',
      $md$- For read-only requests (list / show / search), act directly — don't ask clarifying questions first.
- When a request is ambiguous, take the most reasonable interpretation and proceed, stating the assumption you made.
- Pause to confirm only for destructive or outward-facing actions (deleting, bulk changes, pushing to a remote, publishing).
- Report outcomes honestly — if something failed, was skipped, or is unverified, say so plainly.$md$,
      false
    );
  return new;
end;
$$;

drop trigger if exists seed_baseline_is_on_project on projects;
create trigger seed_baseline_is_on_project
  after insert on projects
  for each row execute function seed_baseline_instructions();
