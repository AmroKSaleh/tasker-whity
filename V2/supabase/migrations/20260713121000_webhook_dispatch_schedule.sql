-- TDE-377 (Path B): drive the outbound-webhook drain. A pg_cron job pings the webhook-dispatch
-- edge function every minute; the function reads due deliveries, signs + POSTs, advances retries.
-- The cron→function auth secret is GENERATED IN-DB and stored in Vault, so nothing sensitive is
-- ever committed to the repo: cron reads it via SQL, the function reads it via a service-role-only
-- RPC. Idempotent — safe to re-run.

create extension if not exists pg_net;
create extension if not exists supabase_vault;

-- One-time: generate a random dispatch secret and store it in Vault (only if absent). Built from
-- two gen_random_uuid()s (64 hex chars) to avoid depending on pgcrypto's schema search path.
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'webhook_dispatch_secret') then
    perform vault.create_secret(
      replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''),
      'webhook_dispatch_secret',
      'TDE-377: shared secret the cron drain sends to the webhook-dispatch edge function');
  end if;
end $$;

-- The edge function (service role) reads the same secret through this locked-down RPC. anon /
-- authenticated cannot execute it, so the secret never leaves the service-role boundary.
create or replace function public.get_webhook_dispatch_secret()
returns text
language sql
security definer
set search_path = ''
as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'webhook_dispatch_secret' limit 1
$$;
revoke execute on function public.get_webhook_dispatch_secret() from public;
revoke execute on function public.get_webhook_dispatch_secret() from anon;
revoke execute on function public.get_webhook_dispatch_secret() from authenticated;
grant execute on function public.get_webhook_dispatch_secret() to service_role;

-- Drain every minute. Re-scheduling with the same job name replaces it (idempotent).
select cron.unschedule('webhook-dispatch-drain')
  where exists (select 1 from cron.job where jobname = 'webhook-dispatch-drain');

select cron.schedule(
  'webhook-dispatch-drain',
  '* * * * *',
  $$
    select net.http_post(
      url     := 'https://rzjhmipbamyvpwlkfvxx.supabase.co/functions/v1/webhook-dispatch',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-dispatch-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'webhook_dispatch_secret')
      ),
      body    := '{}'::jsonb,
      timeout_milliseconds := 5000
    );
  $$
);
