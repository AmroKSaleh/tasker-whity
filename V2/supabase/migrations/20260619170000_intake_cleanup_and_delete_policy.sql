-- One-time cleanup: clear the awaiting intake queue (test captures of the RBAC
-- email). Leaves 'imported' jobs intact so placed-task provenance survives.
delete from intake_jobs where status in ('pending', 'processing', 'ready', 'error', 'done');

-- Missing piece: users could select/insert/update their intake jobs but not DELETE.
-- Add it so the Conductor can offer a Dismiss action on in-flight/parked cards.
create policy "intake own delete" on intake_jobs for delete using (auth.uid() = user_id);
