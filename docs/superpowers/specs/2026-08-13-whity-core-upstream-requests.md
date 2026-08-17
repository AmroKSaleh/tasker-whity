# Tasker ↔ whity-core: using it as intended, and what we need back

**Date:** 2026-08-13
**Audited against:** `v0.2.2` (`b0c0364f18caa8731358b6a2ee78147c5ff67ca8`), 83 commits ahead of Tasker's then-current pin `cc126f66`
**Status:** Part 1 is Tasker's own work to do. Part 2 is a request to whity-core.

Tasker is being ported onto whity-core as a hot-loaded plugin, and the intent is to be a good citizen: **use the platform as designed, and ask for a seam rather than building around its absence.**

This audit was run against v0.2.2 itself, not inferred from an older pin. It found two places where Tasker is *not* using core as intended — those come first, because a request list is not credible while our own house is out of order — and seven seams core genuinely lacks.

---

# Part 1 — Where Tasker is not using core as intended

## 1.1 Tasker emits no domain events, so none of its mutations reach the audit trail

**This is the most consequential finding in the audit, and it contradicts a stated premise of the port.**

The project's Foundation says whity-core "already provides multi-tenancy, RBAC, SSO/2FA, audit, tagging, jobs and a real MCP server… **porting means those come for free**."

Audit does not come for free. It comes from dispatching events that core's `AuditLogger` subscribes to. A repo-wide search of `plugin/` finds **zero** dispatch calls: the only `HookManager` references are a PHPStan stub and a comment in the environment aliases. So every board mutation — `create_project`, `create_task`, `complete_task`, `delete_section`, `delete_project`, and every flow mutation D5a is adding — writes to PostgreSQL and announces nothing.

The irony is that Tasker already understands the mechanism precisely. Its environment aliases **delegate** to core's `OusApiHandler` specifically so that `ou.*` hooks fire and the platform audit trail stays complete, with a docblock explaining that writing to `organizational_units` directly "would silently drop OU changes out of the platform audit trail." That exact reasoning was never applied to Tasker's own tables.

The SDK's `Hooks/Events.php` publishes the wire contract and naming convention (`user.creating` / `user.created` / `user.created.async`, `tenant.*`, `role.*`, `ou.*`), so the pattern to follow is already documented — including the pre/post split and the `.async` variants that feed the durable event spine.

**What Tasker should do:** dispatch `tasker.project.*`, `tasker.task.*`, `tasker.section.*`, `tasker.flow.*` and so on through the container's shared `HookManager`, following the SDK's naming and pre/post conventions. Then whity's audit, and anything else subscribing to the spine, sees Tasker's domain the way it sees core's.

**Worth asking upstream (see 2.8):** whether core wants plugin events namespaced (`tasker.task.created`) or registered against a declared catalogue, so `AuditLogger` renders them well rather than treating them as opaque.

## 1.2 Tasker's OU scoping diverges from core's own portable convention

`plugin/Access/OuScopeResolver::whereFragment()` emits:

```sql
(:unrestricted = TRUE OR {$column} IS NULL OR {$column} = ANY(:scope))
```

`= ANY(:scope)` is PostgreSQL-only. It fails at `PDO::prepare()` under SQLite **before any binding**, which is why every OU-aware method in Tasker must be tested in a separate Postgres-only file, why each of the 13 D5a tasks has to reason about which tier its tests belong in, and why several tasks in the previous slice lost time relocating coverage between tiers.

Core solves the same problem portably. `Api/TwoFactorPoliciesApiHandler.php:292`:

```php
$sql .= ' AND ou_id IN (' . implode(', ', array_fill(0, count($ouIds), '?')) . ')';
```

and `Core/Delegation/DelegationRepository.php:300` does the same with `(ou_id IS NULL OR ou_id IN (...))`. Numbered placeholders, portable to SQLite.

So this is not a core limitation — it is Tasker diverging from core's established pattern and paying for it in test-architecture complexity on every single task. Adopting core's form would **collapse the two-tier split**, letting OU-aware handlers be unit-tested on SQLite.

**What Tasker should do:** re-emit the predicate with numbered placeholders, keeping the `IS NULL` and unrestricted-caller branches, then migrate the Postgres-only tests that exist solely because of the syntax back to the fast tier. This is a contained change with a large payoff, and it should be a task of its own rather than folded into feature work.

## 1.3 Optional SDK capability interfaces Tasker does not implement

These are opportunities, not defects — each is explicitly additive.

- **`PluginHealthProbesInterface`** — Tasker contributes no health probes, so core's health surface cannot report on Tasker's database objects or its MCP tool derivation. A plugin this large should be probeable.
- **`PluginMcpInterface`** — this is for MCP **prompt templates**, not tools (tools derive from route `schema.operationId`, which Tasker does correctly). Tasker has a great deal of embedded procedural guidance in its tool descriptions; some of it belongs in prompt templates that core registers.

Confirmed correct and left alone: Tasker declares its permissions through `getPermissions()` (`TaskerPlugin.php:1634`), uses `MigrationInterface` for schema, `PluginRequirementsInterface` for its dependency floor, and derives MCP tools from the route table. Those are all the intended paths.

---

# Part 2 — Seams core lacks, ordered by cost

Each item states what breaks, what Tasker does instead, and what would let the workaround be deleted.

## 2.1 Plugins cannot register queue jobs, so the shipped worker cannot run them

**Highest cost: it blocks two Tasker slices and forces a parallel worker.**

`JobInterface` is in the SDK and `JobRegistry::register(string $name, JobInterface $handler, bool $submittable = false)` exists, so a plugin can legitimately write a handler — and `CoreJobs`' own docblock calls what it registers the "core (**non-plugin**)" handlers, so the category is anticipated.

But nothing discovers them. At v0.2.2, `Cli/Commands/QueueWorkCommand.php:66` still builds a bare registry and populates it with core's handlers only:

```php
$registry = new JobRegistry();
CoreJobs::register($registry, $pdo, null, $this->logger);
```

`PluginLoader` has no jobs awareness, so a plugin's job is dead-lettered as *"No handler registered for job."*

**Tasker's planned workaround:** ship its own `queue:work` that builds a registry with `CoreJobs::register()` plus its own handlers and hands it to core's genuine `JobRunner`, exploiting `QueueWorkCommand`'s injectable `$runner`/`$repo`. Public APIs only. But the operator then runs two workers, and every plugin repeats the trick.

**What would retire it:** a `PluginJobsInterface` returning `[name => JobInterface]`, discovered by `PluginLoader` and registered into the registry the standard worker builds.

**Blocks:** Tasker's D7 (intake polling, agent sessions) and D9 (integration sync). **This is the only item blocking planned work** — and we would rather wait for the seam, or contribute it, than ship the parallel worker.

## 2.2 `resources/read` hands plugin handlers a different `Request` class than the other transports

**High cost: it shipped as a live 500 that the test suite structurally could not see.**

`Whity\Core\Request` is an empty subclass of `Whity\Sdk\Http\Request`. Core's API handlers type-hint the **core** class; `Mcp/Resources/ResourcesReadHandler.php:17` — unchanged at v0.2.2 — imports and constructs the **SDK** class. HTTP passes a core `Request` (`fromGlobals()` is `new static`) and `tools/call` passes a core `Request`. Only `resources/read` differs.

A plugin route that narrows to the core type — as it must, to call a core handler — therefore returns 500 on exactly one of three transports. Tasker hit this for real: `list_environments` 500'd over `resources/read` while passing every test, because tests construct core `Request`s.

**Tasker's workaround:** a `toHostRequest()` that re-wraps an SDK request into a core one, carrying method, path (query string included), headers and body across.

**What would retire it:** have `ResourcesReadHandler` build the same type the other transports build, or relax core handlers to accept the SDK parent.

**A related question we would rather ask than assume:** is instantiating a core API handler (`new OusApiHandler($pdo, $hooks)`) from plugin code the **intended** way for a plugin to alias a core capability? It is what Tasker does for environments, chosen so `ou.*` hooks fire. If there is a supported plugin→core path we have missed, we would rather use it.

## 2.3 Core's own OU routes carry no permission slug, so an aliasing plugin must mirror a role check

At v0.2.2, `public/index.php:1396-1397`:

```php
$router->register('GET',  '/api/ous', [$ousHandler, 'list'],   'admin');
$router->register('POST', '/api/ous', [$ousHandler, 'create'], 'admin');
```

Gated on the `admin` **role**, no `requiredPermission`. Migration 005 seeds `ous:read`/`create`/`update`/`delete`/`assign`, but those slugs appear nowhere in `src/` or `public/` beyond `CorePermissions`' own catalogue — they are vestigial.

So a plugin aliasing OU management has no slug to reuse. It either mirrors `requiredRole: 'admin'` — which Tasker does — or invents one like `tasker_environment:manage`. **The invented slug is the dangerous option:** it would let a caller holding board permissions mutate platform-wide OUs without holding any OU permission. Tasker's review caught that and chose the mirror; the next plugin may not.

**What would retire it:** wire the seeded `ous:*` slugs onto those routes.

## 2.4 `MembershipRepository::findByProfile()` ignores membership status

At v0.2.2, `src/Core/Identity/MembershipRepository.php:113`:

```php
'SELECT * FROM memberships WHERE profile_id = :profile_id AND tenant_id = :tenant_id LIMIT 1'
```

No `status` predicate — so a **suspended or pending** membership still resolves as a valid caller, and its `ou_id` still scopes every downstream query. Tasker calls this to resolve caller OU on every request, so a suspended member keeps their scope.

v0.2.2's changelog states resource-grant resolution "gates on an ACTIVE membership in the tenant *before* consulting resource grants," pinned by a test on a suspended member. So the RBAC path does check status, which makes this repository method the inconsistent one.

**There is no workaround available to us** — filtering it ourselves would mean duplicating core's membership semantics.

**What would fix it:** filter on active status here, or add `findActiveByProfile()` and document `findByProfile()` as deliberately status-agnostic. Either is fine; the silent ambiguity is the problem.

## 2.5 A plugin route cannot return a controlled error and keep core's structured logging

`PluginLoader::wrapHandler()` logs a structured entry with stack trace and tenant id on an **uncaught** throwable, and records the failure against the plugin lifecycle. Tasker wants that. But a route that must not leak an internal error has to catch — and catching means `wrapHandler()` never sees it. The two goals are mutually exclusive.

Tasker hit this in the environment aliases: the failure most worth diagnosing (an unregistered `HookManager` or `Database`) surfaced as a generic 500 with **zero** diagnostics anywhere, until Tasker added a parallel `error_log()`.

**What would retire it:** an SDK-visible way to report a handled throwable into the same boundary — `\Whity\report_handled($e, $context)`, or a `PluginLoader` hook.

## 2.6 `app()` silently returns an unwired service instead of failing

`src/helpers.php`'s `app()` resolves from `$GLOBALS['whity_services']` and auto-instantiates a class whose constructor has no required parameters. `HookManager::__construct(?DomainEventStore = null, ?LoggerInterface = null)` qualifies.

So a plugin asking for the shared `HookManager` cannot distinguish the wired instance with `AuditLogger` subscribed from a fresh one with no subscribers — an `instanceof` check passes either way. If registration were ever missed, hooks would dispatch into a void and mutations would silently leave no audit trail: precisely the outcome Tasker delegates to core in order to avoid. Latent today, because production registers unconditionally at bootstrap — but undetectable from the plugin side.

**What would retire it:** a strict accessor, `\Whity\service(X::class)`, that throws when unregistered, leaving `app()`'s convenience intact.

## 2.7 The MCP tool surface cannot be derived without a running host

Tasker's `mcp:check` compares live `tools/list` output against a committed snapshot, requiring an MCP-enabled host, an admin login and a bearer token. CI has no host, so the check that guards the snapshot every future slice is measured against is a manual local run.

Tasker covered the shape half by deriving offline through core's real `ToolDeriver` against its own route table, which runs in CI. That does not cover "does the host actually derive what we think."

**What would retire it:** a core CLI that derives the surface from loaded plugins without serving a request — `bin/whity mcp:tools --json`.

## 2.8 Guidance wanted: how should a plugin name and register its domain events?

Not a defect — a question, and the one that unblocks fixing our own §1.1 properly.

The SDK's `Events` class publishes core's contract (`user.*`, `tenant.*`, `role.*`, `ou.*`) with a pre/post/`.async` convention. Before Tasker starts emitting `tasker.task.created` and friends, we would like to know:

- Should plugin events be namespaced by plugin slug, and is `tasker.task.created` the shape you want?
- Should a plugin **declare** its event catalogue (as it declares permissions via `getPermissions()`), so `AuditLogger` can render them with proper labels rather than treating them as opaque strings?
- Do you want the `.creating` veto variant available to plugin events, so other plugins can veto Tasker mutations through `HookVetoException`?

We will follow whatever convention you prefer; picking one unilaterally is how two sources of truth start.

---

## Summary

**Ours to fix (Part 1):**

| # | Gap | Cost of leaving it |
|---|---|---|
| 1.1 | No domain events dispatched | Tasker's entire domain is absent from the platform audit trail |
| 1.2 | OU scoping diverges from core's portable `IN (...)` convention | Forces a two-tier test split on every task |
| 1.3 | No health probes; no MCP prompt contributions | Missed platform integration |

**Requests (Part 2):**

| # | Ask | Retires | Blocks |
|---|---|---|---|
| 2.1 | Plugin job registration + worker discovery | Tasker's parallel `queue:work` | **D7, D9** |
| 2.2 | One `Request` type across MCP transports | `toHostRequest()` re-wrap | — |
| 2.3 | Permission slugs on core's OU routes | Mirrored `requiredRole: 'admin'` | — |
| 2.4 | Status-aware membership lookup | *(no workaround possible)* | — |
| 2.5 | Report a handled throwable into core's boundary | A parallel `error_log()` | — |
| 2.6 | Strict service accessor | *(latent, undetectable)* | — |
| 2.7 | Offline tool-surface derivation | `mcp:check` staying out of CI | — |
| 2.8 | Plugin event naming/registration guidance | Unblocks fixing §1.1 correctly | — |

2.1 is the only item blocking planned work, and 2.8 is the cheapest to answer.
