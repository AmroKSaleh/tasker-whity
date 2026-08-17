# Prompt for the whity-core developers

Hand this over as-is. It is self-contained: every claim carries a `file:line` at `v0.2.2` so nothing has to be taken on trust or looked up.

---

## Context

We are building **Tasker**, a project/task-management application, as a hot-loaded whity-core plugin. It is a port of an existing Supabase app onto the platform, and it is substantial — 52 MCP tools so far, 8 tables, ~1,000 tests, heading toward the original's full 143-tool surface.

Our working rule is that **we never patch `host/.core/`**. Where the platform gives us a seam we use it; where it does not, we would rather ask you for one than build around you. This document is the "ask" half of that.

Everything below was verified against **`v0.2.2`** (`04b21e8b`, tag object `b0c0364f`) directly — not inferred from an older pin. We bumped to it specifically to check, and the bump required **zero plugin-side changes**, which we take as a good sign about the platform's stability.

**Before the requests, the two things we found wrong on our own side**, because a request list is not credible otherwise:

1. **We dispatch no domain events at all.** Every Tasker mutation writes to Postgres and announces nothing, so our entire domain is absent from the platform audit trail — while we had been telling ourselves audit "comes for free" from porting. It does not; it comes from emitting events `AuditLogger` subscribes to. We are fixing this, and request 8 below is the one thing we need from you first.
2. **Our OU scoping diverged from yours.** We emit `ou_id = ANY(:scope)`, PostgreSQL-only, which forced our entire test suite into a two-tier split. You solve the same problem portably with `ou_id IN (?, ?, ?)` (`src/Api/TwoFactorPoliciesApiHandler.php:292`, `src/Core/Delegation/DelegationRepository.php:300`). That was us not following your convention, and we are changing to match.

We are happy to submit PRs for any of the below rather than just filing requests — say which you would accept and we will write them.

---

## Request 1 — A plugin job registration seam. **This is the only item blocking planned work.**

**What exists:** `JobInterface` is in the SDK (`sdk/src/JobInterface.php`, one method `handle(array $payload): array`), and `JobRegistry::register(string $name, JobInterface $handler, bool $submittable = false)` is public. `CoreJobs`' own docblock describes what it registers as the *"core (**non-plugin**)"* handlers — so the plugin category is clearly anticipated.

**What is missing:** nothing discovers plugin jobs. `src/Cli/Commands/QueueWorkCommand.php:66` builds a bare registry and populates it with core's handlers only:

```php
$registry = new JobRegistry();
CoreJobs::register($registry, $pdo, null, $this->logger);
```

`PluginLoader` has no jobs awareness. So a job a plugin submits today is dead-lettered by the shipped worker as *"No handler registered for job."*

**What we would do without it:** ship our own `queue:work` command that builds a registry with `CoreJobs::register()` plus our handlers and hands it to your real `JobRunner`, exploiting the fact that `QueueWorkCommand`'s `$runner`/`$repo` are constructor-injectable. It works and patches nothing — but the operator then runs two workers, and every plugin that wants a job repeats the trick. **We would rather not ship it.**

**What we are asking for:** a `PluginJobsInterface` returning `[name => JobInterface]`, discovered by `PluginLoader` and registered into the registry the standard worker builds — the same shape as the optional capability interfaces you already have.

**Why it matters to us:** two whole slices of our roadmap (intake polling / agent sessions, and integration sync) are designed around it. They are currently on hold rather than built on a workaround.

---

## Request 2 — Give plugin handlers the same `Request` type on every MCP transport

`Whity\Core\Request` is an empty subclass of `Whity\Sdk\Http\Request`. Your API handlers type-hint the **core** class. But `src/Mcp/Resources/ResourcesReadHandler.php:17` imports and constructs the **SDK** class:

```php
use Whity\Sdk\Http\Request;
...
new Request('GET', $path, ['content-type' => 'application/json'], '')
```

HTTP passes a core `Request` (`fromGlobals()` is `new static`), and `tools/call` passes a core `Request`. Only `resources/read` differs.

**How this bit us:** we alias your OU endpoints as "environments", delegating to `OusApiHandler` so your `ou.*` hooks fire and the audit trail stays complete. That means narrowing to the core `Request` type. Result: the tool returned **500 on `resources/read` only**, while passing every test — because our tests construct core `Request`s, so the transport that differs was the one nothing exercised. We now re-wrap with a private `toHostRequest()`.

**What we are asking for:** either have `ResourcesReadHandler` build the same type the other two transports build, or relax core handlers to accept the SDK parent. Either way one type reaches handlers regardless of transport.

**A related question we would rather ask than assume:** is instantiating a core API handler (`new OusApiHandler($pdo, $hooks)`) from plugin code the **intended** way for a plugin to alias a core capability? We chose it so hooks fire. If there is a supported plugin→core path we have missed, we would rather use that.

---

## Request 3 — Wire permission slugs onto your own OU routes

`public/index.php:1396-1397`:

```php
$router->register('GET',  '/api/ous', [$ousHandler, 'list'],   'admin');
$router->register('POST', '/api/ous', [$ousHandler, 'create'], 'admin');
```

Gated on the `admin` **role**, with no `requiredPermission`. Migration 005 seeds `ous:read`/`create`/`update`/`delete`/`assign`, but those slugs appear nowhere in `src/` or `public/` beyond `CorePermissions`' own catalogue — they are vestigial.

**Why this is a hazard, not just a gap:** a plugin aliasing OU management has no slug to reuse. It either mirrors `requiredRole: 'admin'`, or invents one like `tasker_environment:manage`. **The invented slug is actively dangerous** — it would let a caller holding only our board permissions mutate platform-wide OUs without holding any OU permission. Our review caught that and we chose the mirror. The next plugin may not.

**What we are asking for:** wire the seeded `ous:*` slugs onto those routes, so an aliasing plugin inherits your authority model instead of guessing at it.

---

## Request 4 — Make membership status explicit in `findByProfile()`

`src/Core/Identity/MembershipRepository.php:110-118`:

```php
'SELECT * FROM memberships WHERE profile_id = :profile_id AND tenant_id = :tenant_id LIMIT 1'
```

No `status` predicate. So a **suspended or pending** membership still resolves as a valid caller, and its `ou_id` still scopes every query built from it. We call this to resolve caller OU on every request, so a suspended member keeps their scope.

Your own v0.2.2 changelog says resource-grant resolution "gates on an ACTIVE membership in the tenant *before* consulting resource grants", pinned by a test on a suspended member — which makes this repository method the inconsistent one, and the more surprising for it.

**There is no workaround available to us**: filtering it ourselves would mean duplicating your membership semantics in a plugin, which is exactly the two-sources-of-truth problem we are trying to avoid.

**What we are asking for:** either filter on active status here, or add `findActiveByProfile()` and document `findByProfile()` as deliberately status-agnostic. Either is fine — the silent ambiguity is the problem, because the method name promises neither.

---

## Request 5 — Let a plugin report a handled throwable into your error boundary

`PluginLoader::wrapHandler()` logs a structured entry with stack trace and tenant id on an **uncaught** throwable, and records the failure against the plugin lifecycle. We want that.

But a route that must not leak an internal error to the caller has to catch — and catching means `wrapHandler()` never sees it. The two goals are mutually exclusive today.

**How this bit us:** the failure most worth diagnosing in our environment aliases (an unregistered `HookManager` or `Database`) surfaced as a generic 500 with **zero** diagnostics anywhere, until we added a parallel `error_log()` that duplicates what your boundary already does better.

**What we are asking for:** an SDK-visible way to report a handled throwable into the same boundary — `\Whity\report_handled($e, $context)`, or a `PluginLoader` hook.

---

## Request 6 — A strict service accessor alongside `app()`

`src/helpers.php`'s `app()` resolves from `$GLOBALS['whity_services']` and auto-instantiates a class whose constructor has no required parameters. `HookManager::__construct(?DomainEventStore = null, ?LoggerInterface = null)` qualifies.

So a plugin asking for the shared `HookManager` **cannot distinguish** the wired instance with `AuditLogger` subscribed from a fresh one with no subscribers — an `instanceof` check passes either way. If registration were ever missed, hooks would dispatch into a void and mutations would silently leave no audit trail: precisely the outcome we delegate to core in order to avoid.

Latent today, since production registers unconditionally at bootstrap. But undetectable from the plugin side, and the failure is silent.

**What we are asking for:** `\Whity\service(X::class)` that throws when unregistered, leaving `app()`'s convenience behaviour untouched.

---

## Request 7 — A way to derive the MCP tool surface without a running host

We keep a committed snapshot of our derived tool surface and diff the live `tools/list` against it, so a tool silently changing shape fails a check. That check needs an MCP-enabled host, an admin login and a minted bearer token — so it cannot run in CI, and it is the thing guarding the baseline every future slice is measured against.

We covered the shape half by deriving offline through your real `ToolDeriver` against our own route table, which does run in CI. That does not cover "does the host actually derive what we think."

**What we are asking for:** a core CLI that derives the surface from loaded plugins without serving a request — e.g. `bin/whity mcp:tools --json`.

---

## Request 8 — Guidance: how should a plugin name and register its domain events?

**Not a defect — a question, and the cheapest thing on this list to answer.** It is also the one that unblocks fixing our own biggest gap.

`sdk/src/Hooks/Events.php` publishes your contract (`user.creating` / `user.created` / `user.created.async`, `tenant.*`, `role.*`, `ou.*`) with a clear pre/post/`.async` convention. Before we start emitting events for our domain, we would like to know:

1. Should plugin events be namespaced by plugin slug — is `tasker.task.created` the shape you want?
2. Should a plugin **declare** its event catalogue, the way it declares permissions via `getPermissions()`, so `AuditLogger` can render them with proper labels instead of treating them as opaque strings?
3. Should the `.creating` veto variant be available to plugin events, so other plugins can veto our mutations via `HookVetoException`?

We will follow whatever convention you prefer. Choosing one unilaterally is how two sources of truth start, and we would rather ask.

---

## Summary

| # | Ask | Blocking us? |
|---|---|---|
| 1 | Plugin job registration + worker discovery | **Yes — two slices on hold** |
| 8 | Plugin event naming/registration guidance | Yes — blocks our own audit fix |
| 2 | One `Request` type across MCP transports | No (worked around) |
| 3 | Permission slugs on core's OU routes | No (mirrored a role) |
| 4 | Status-aware membership lookup | No workaround possible |
| 5 | Report a handled throwable into your boundary | No (duplicated it) |
| 6 | Strict service accessor | No (latent) |
| 7 | Offline tool-surface derivation | No (partial coverage) |

**If you only do two things: 1 and 8.** One unblocks planned work; the other is a paragraph of guidance that lets us stop being a plugin with no audit trail.

Full reasoning, including the two items we are fixing on our own side, is in `docs/superpowers/specs/2026-08-13-whity-core-upstream-requests.md` in the Tasker repo.
