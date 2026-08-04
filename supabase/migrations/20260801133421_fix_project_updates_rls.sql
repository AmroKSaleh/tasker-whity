drop policy if exists "Users can read their own project updates" on project_updates;
drop policy if exists "Users can insert their own project updates" on project_updates;
drop policy if exists "Users can update their own project updates" on project_updates;
drop policy if exists "Users can delete their own project updates" on project_updates;

create policy "project_updates access" on project_updates for all
  using (user_id = auth.uid() or can_access_project(project_id))
  with check (user_id = auth.uid() or can_access_project(project_id));
