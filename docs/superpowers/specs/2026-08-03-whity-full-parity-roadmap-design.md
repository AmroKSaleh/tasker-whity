# Tasker on whity-core — Full-Parity Roadmap

**Date:** 2026-08-03
**Status:** Approved design. Decomposition and sequencing only — each slice gets its own spec.
**Predecessor:** [2026-08-02-whity-core-port-design.md](2026-08-02-whity-core-port-design.md) (slice one, implemented as Plan A)

---

## 1. Goal

Make Tasker fully operational on whity-core at **full parity with the Supabase app**, and take whity's platform features — SSO, 2FA, notifications, tagging, audit, storage, jobs, MCP infrastructure — rather than porting Tasker's homegrown equivalents.

Parity is measured against the Supabase app's behaviour, not against a tool count: 131 MCP handlers, 65 migrations, and the board, flows, knowledge, local-mode, integration and agent-ops domains they implement.

Plan A is complete: Tasker's own whity-core host runs, an SDK-only plugin loads, tenant isolation is proven by the SDK conformance kit, an RBAC-gated API works, MCP tools derive from route declarations, and the SPA round-trips under same-origin cookie auth. This document plans everything after that.

**This is a long road: thirteen sub-projects, each with its own spec, plan, and review cycle.** Plan A was the smallest of them and still took seven tasks, five fix rounds and a whole-branch review. The dominant risk for a project this size is not a technical mistake — it is abandonment partway. The sequencing below is chosen accordingly.

---

## 2. Decisions

| # | Decision | Choice |
|---|---|---|
| E1 | Overlap policy | **Adopt whity's, delete Tasker's** wherever a feature exists in both |
| E2 | Finish line | **Full parity** with the Supabase app: all MCP tools, flows, IS/KB, local mode, integrations, intake/agent ops |
| E3 | Data migration | **Manual**, using Tasker's existing `export_project` / `import_project` |
| E4 | Sequencing | **Platform-first** — adopt the platform before building any Tasker domain on it |
| E5 | Parity target | **Freeze the old app now.** Bug fixes only on Supabase; parity means what it does today |
| E6 | Local mode timing | **Brought forward** to just after board transfer, accepting rework, so `.tasker/` dogfooding migrates early |
| E7 | Agent tool names | **Preserved**. Implementations change; MCP tool names and argument shapes do not |

---

## 3. What comes free, and what does not

whity-core ships 49 API handler areas. Cross-referenced against Tasker's MCP surface and 65 migrations.

*A note on counting the tool surface:* grepping `mcp/index.ts` yields 131 distinct handler names, while the running MCP server exposes closer to 180 callable tools — some tools share a handler, and some names are aliases. Where this document needs a figure, it uses the source count of **131 handlers**, because that is what has to be ported. The exposed-tool count matters only to §6's continuity contract, which is enforced by snapshot rather than by counting.

### Free — adopt and delete Tasker's version

| Tasker built | whity ships |
|---|---|
| `local_device_tokens` | `DeviceApiHandler`, MCP token endpoints |
| `tags text[]` on tasks | `tags`, `tag_groups`, `entity_tags` |
| `agent_activities`, `mcp_error_logs` | `audit_log` |
| Google OAuth, half-finished | `SsoAuthHandler`, `IdentityProvidersApiHandler` |
| `theme_preference` column | `ThemeApiHandler`, `BrandingApiHandler` |
| `webhooks` + `webhook_dispatch` cron | `jobs` (`JobsApiHandler`) |
| Google Drive as the file store | `TenantStorageConfigApiHandler` + Storage |
| `organizations`, `organization_members`, `environment_grants` | `TenantsApiHandler`, `OusApiHandler`, `DelegationsApiHandler` |
| — *(Tasker has none)* | `TwoFactorHandler`, `SessionsApiHandler` |
| — *(Tasker's own spec lists this as a limitation)* | notifications: preferences, tenant settings, metrics, mail settings, inbox |

Notifications are the standout: due dates already exist in Tasker and reminders never did. The capability arrives as configuration.

### Not free — Tasker's genuine domain value, ported not adopted

Flows, steps, contracts and gates; flow templates and exceptions; instruction sets; the knowledge base; local mode; intake jobs; agent sessions, reviews and validation; task seeds; phases; focus scoring.

**One assumption that did not survive checking:** `relations` is person-specific (`from_person_id … REFERENCES persons`), not a generic graph. Tasker's task I/O edges — `add_task_link`, `set_task_input`, `set_task_output`, which are what flows are built on — therefore stay a Tasker-owned table.

**The free tier is infrastructure. The paid tier is domain logic.**

---

## 4. Structural consequences

### 4.1 Dual keys on every Tasker table

whity's cross-cutting tables assume integer ids: `entity_tags.entity_id BIGINT`, `audit_log.target_id INTEGER`, `notifications.recipient_profile_id BIGINT`, `jobs.id BIGSERIAL`. The slice-one spec put **uuid** primary keys on Tasker's tables, justified because the SPA, MCP tools and `.tasker/` files all assume uuid. Both cannot hold.

**Every Tasker table therefore carries both:**

- `id BIGSERIAL PRIMARY KEY` — internal, and what `entity_tags`, `audit_log` and `jobs` reference
- `public_id UUID NOT NULL UNIQUE` — the external identifier used by the API, MCP tools, and `.tasker/` files

The external uuid contract is unchanged; rows become addressable by the platform's machinery. Cost is one column and one index per table. This is cheap now and near-impossible to retrofit once D5–D8 exist — which is the concrete argument for platform-first.

**This supersedes** the slice-one spec's identifier decision (§6, "Identifiers"). Plan A's `tasker_pings` predates it and is throwaway.

A useful side effect: because `public_id` remains the external identifier, `.tasker/` file contents are unaffected by the internal keys. Local mode inherits a stable contract.

### 4.2 Permission slugs

Established during Plan A and unchanged here: exactly one colon, matching `/^[a-z][a-z0-9_]*:[a-z][a-z0-9_]*$/`. Multi-word resources use an underscore (`tasker_project:view`). An invalid slug makes the loader drop the route with only a logged warning.

---

## 5. Sequencing

Platform-first: adoption precedes the code that depends on it, because adoption is cheap before and expensive after.

### Phase 1 — Platform foundations

Built on Plan A's proven seams, before any Tasker domain exists. Nothing is deleted yet, because Tasker's versions are not ported yet — the cheapest possible moment.

| Slice | Contents |
|---|---|
| **P1 Identity** | SSO, 2FA, sessions, registration, email verification. Largely configuration and UI wiring. Deletes the half-built OAuth pages |
| **P2 Cross-cutting** | `entity_tags`, `audit_log`, `jobs`, theme/branding, notifications, storage |
| **P3 Agent platform** | AI principals, MCP tokens, MCP tools admin, rate limits. Conventions and infrastructure — domain tools derive per slice |
| **P4 AI platform** | Provider key storage and the server-side proxy. Retires Plan A's `tasker_user_ai_settings` debt before anything depends on it |

**Deliberate exception:** P4's consumers are board features (project generation, task chat, focus reasons). Phase 1 builds only the platform half — key storage, proxy, principals. Feature wiring lands with D2. Building the whole of P4 first would mean a proxy with nothing to call it.

### Phase 2 — Tasker domains on finished foundations

| Slice | Contents |
|---|---|
| **D1 Board backend** | Seven tables with dual keys; OU descendant scope resolver; routes. Task tags are `entity_tags` from the first commit; mutations write `audit_log`; `tags text[]` never exists. Establishes the patterns for scale: per-resource route providers, one components registry, a `withTenant()` helper, a handler logging seam |
| **D2 Board frontend** | De-Supabase the wired pages behind `app/src/api/`. AI features call P4's proxy. First change to `client.js`: narrow the 204 catch that currently swallows any malformed-JSON body as `null` |
| **D3 Board transfer** | `import_project` accepting the old `tasker_export` format, so real projects can move |
| **D4 Local mode (board)** | `.tasker/` files, leases, tombstones, structure manifest, frozen slugs — for board entities only |
| **D5 Flows & gates** | Flows, steps, contracts, gates, templates, exceptions, run/resume/stop. Includes the Tasker-owned task I/O edge table. **Extends the local-mode projection** |
| **D6 Knowledge (IS + KB)** | Instruction sets (project, flow, default), knowledge base, categories, archive sweep, health. **Extends the local-mode projection** |
| **D7 Intake & agent ops** | Intake jobs, agent sessions, reviews, validation, guidance, seeds, drafts, phases, ranking. **Extends the local-mode projection** |
| **D8 Full transfer** | Export/import extended to flows and knowledge |

**On E6's accepted rework:** local mode moves ahead of the remaining domains, so it cannot be built once against final shapes. Rather than building it twice, D4 ships the board projection and **each later domain slice owns extending it**. This converts a rewrite into additive work, and makes each slice responsible for its own file-format surface.

### Phase 3 — Edges

| Slice | Contents |
|---|---|
| **D9 Integrations** | GitHub, Drive, Google Tasks, Gmail — rebuilt on whity storage, jobs and identity providers instead of Supabase edge functions |

---

## 6. The tool-surface continuity contract

Adopting whity's implementations changes what runs underneath. It does **not** have to change what agents call.

whity derives each MCP tool's name from its route's `schema.operationId`, so the names are ours to choose. Every domain slice therefore preserves the existing tool name and argument shape: `complete_task`, `get_ready_work`, `create_flow_kb_entry`, and the rest. **Agent workflows survive a total backend replacement.** This is a binding constraint on every slice, and Plan A's tool-surface snapshot test is what enforces it.

Three qualifications:

- **Deleted features lose their tools.** `mint_device_token` and `revoke_device_token` become whity device and MCP-token endpoints.
- **Moved concepts change shape.** `create_environment` and `list_environments` become thin aliases over core's OU endpoints.
- **The net surface shrinks**, because webhooks, device tokens and error logs stop being Tasker's problem.

---

## 7. Verification

Every slice carries the same four gates, inherited from Plan A:

1. **Tenant-isolation conformance** on every new table, via the SDK kit. Non-negotiable — it is the invariant the platform rests on.
2. **OU descendant-scoping tests** wherever visibility applies.
3. **OpenAPI drift check plus the MCP tool-surface snapshot.** The snapshot is what makes §6's promise real; without a failing build on a drifted name, the promise is decoration. It must run in CI.
4. **Vitest** on the API layer, **Playwright** on the user path.

Two additions for this roadmap:

- **Export→import round-trip fidelity tests** for D3 and D8.
- **No silent failures.** Plan A produced four (a route dropped for a bad permission slug, a swallowed revoke error, an emptied `.gitkeep`, a masked JSON parse error). At thirteen slices that pattern becomes the dominant source of lost time. Any failure mode a slice introduces must be loud.

**CI must actually run.** It never has — Plan A's one unverifiable acceptance item, because the repo had no remote. The fork now has one, so the first pull request settles it. Until then, no claim about CI is evidence.

---

## 8. Risks and policies

| Risk | Policy |
|---|---|
| **Parity is a moving target** — the old app has active feature work (`tde-*` branches through TDE-821) | **E5: freeze the old app now.** Bug fixes only. Parity means what it does today. Without this the finish line recedes indefinitely |
| **whity-core moves underneath a long project** | `core.version` stays pinned to a SHA. Schedule deliberate upgrade points *between* phases, with the conformance and snapshot suites as the acceptance test |
| **Dogfooding continuity** | Addressed by E6: local mode moves to D4, so `.tasker/` migrates after board transfer rather than at the end |
| **Windows-only tooling** — every npm script shells to PowerShell, `install-plugin.ps1` uses robocopy | Fine solo; a blocker the day anyone else joins. CI is currently the only Linux path. Port the scripts before onboarding anyone |
| **Inherited security findings** in the copied SPA (`OAuthAuthorizePage`, `SettingsPage`) | Fix-on-touch. Each is unreachable while route-guarded; they must be fixed in the slice that rewires the page, not carried forward |
| **Abandonment partway** | The reason each slice ends in something demonstrable, and the reason this document states the length honestly rather than optimistically |

---

## 9. Carried-forward items from Plan A

These are recorded so they are not lost between plans:

- `app/src/api/client.js` swallows any JSON parse error on a 2xx response as `null`, not only empty 204 bodies. **D2 must narrow it** — it is the seam every API call flows through.
- The clean-clone bootstrap was never proven from true zero (`host/.core` was left in place during the test), so `plugin:deps`'s ordering guard is unexercised on its negative path. Worth one genuine from-zero run.
- `plugin/TaskerPlugin.php` is a loose top-level file and the SDK's predicate scanner takes directories only, so it is permanently unscanned. It holds no SQL today. **D1 should move the tenant seam into a scanned directory** rather than let SQL accumulate there.
- The OU scope resolver will collide with the SDK's predicate scanner, which by design flags conditionally-assembled `WHERE` fragments. **D1 must emit a constant `tenant_id = :tenant_id` and layer the OU predicate on top** — not answer with a blanket `@tenant-guard-ignore`.
- `docs/mcp-tool-surface.json` carries a UTF-8 BOM, which will break the first non-PowerShell consumer — including a CI-hosted drift check.

---

## 10. Definition of done for the roadmap

1. The Supabase app is retired: no daily work depends on it.
2. Every MCP tool that survived §6's qualifications answers with its original name and argument shape, enforced by the snapshot test.
3. Tenant-isolation conformance passes on every Tasker table.
4. Tasker's homegrown duplicates are **deleted**, not parallel: no `tags text[]`, no `webhooks`, no `local_device_tokens`, no `mcp_error_logs`, no `theme_preference`, no `tasker_user_ai_settings`.
5. SSO, 2FA, notifications, audit, storage and jobs work as configuration of the platform rather than Tasker code.
6. `.tasker/` local mode round-trips against the new stack for every domain that has files.
7. CI runs on every pull request and has done so at least once.
