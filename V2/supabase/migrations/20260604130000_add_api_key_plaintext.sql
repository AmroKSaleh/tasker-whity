-- ⚠️ TEMPORARY / CLOSED-TESTING ONLY (added 2026-06-04).
-- Stores the raw API key alongside its hash so the Settings page can re-display
-- it across devices. This DELIBERATELY abandons the hash-only protection: a DB
-- leak would now expose usable keys in the clear. Approved by the owner ONLY for
-- the current closed testing, and MUST be reverted (encrypt-at-rest via Vault, or
-- remove this column) before alpha/beta or growing the tester pool. See the TDE
-- security-debt task tracking this.

alter table public.user_api_keys add column if not exists key_plain text;
