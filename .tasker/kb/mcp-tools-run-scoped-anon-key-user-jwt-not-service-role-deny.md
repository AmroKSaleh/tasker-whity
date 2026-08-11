# MCP tools run SCOPED (anon key + user JWT), not service role — deny-all tables break silently

_KB entry · source: agent · READ-ONLY mirror (edit via create_kb_entry/update_kb_entry over MCP)._

Root cause of TDE-870, found 2026-08-06. The specific bug is fixed; the trap is structural and will recur.

**The fact to internalise.** MCP tool dispatch does NOT use the service-role client. `tools/call` builds `getScopedClient(userId)` — a 5-minute `role: authenticated` JWT signed with `AUTH_JWT_SECRET`, used with the **anon key**. So every tool body runs under RLS as the user. The service-role client exists in the same file and is used for auth resolution and error logging, which makes it easy to assume tools have it too. They don't.

This came from the org/RBAC work and is correct — it's how per-user permissions get enforced.

**The trap.** Several tables were created under the older assumption. `mcp_context_primed` (TDE-371) enabled RLS with **zero policies** and documented why: *"Written/read ONLY by the MCP edge function (service role, bypasses RLS). RLS enabled with no policies = deny-all to normal clients."* Accurate when written. The scoped client silently made the MCP a "normal client", so deny-all started applying to the only thing that used the table.

**Why it survived a month undetected — the part worth generalising.** An RLS denial on SELECT is **not an error**. Rows are filtered out and you get `data: []` with `error: null`. "I'm not permitted to see this row" is byte-identical to "this row does not exist." Any code shaped like `const { data } = await sb.from(X).select(...)` followed by `if (!data) <assume absent>` will take the wrong branch forever, quietly.

The write side had a second, independent silencer: **a supabase-js builder RESOLVES with `{ data, error }` — it does not REJECT on a database error.** So `fireAndForget`'s `.then(() => {}, () => {})` rejection handler was unreachable for exactly the failure it appeared to guard. You must inspect the resolved value; a `catch` is not enough.

**Checklist when adding a table the MCP writes to:**
- Give it own-row RLS policies (`user_id = auth.uid()`), not deny-all. `auth.uid()` equals the scoped JWT's `sub`.
- Include UPDATE if anything upserts — `ON CONFLICT DO UPDATE` is checked against the update policy, not insert.
- Include DELETE if any reset path clears rows. TDE-870 nearly shipped with read/write only, which would have latched the suppression on permanently: primed once, never reset, so `__init_tasker_session` would stop working and agents would get pointers for context they never received.
- Never conclude "absent" from an empty result without reading `error`.

**Second-order lesson.** A table whose correctness depends on *which client happens to call it* has an invisible coupling to auth architecture. Own-row policies work under both service role and scoped client, so they cannot drift. Prefer them to deny-all even when you believe only privileged code will touch the table.

