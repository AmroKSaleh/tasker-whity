# Tasker File Format (`.tasker/`)

**Version:** 1
**Status:** Draft — agreed in design, not yet implemented
**Reference example:** [`V2/examples/blog-post-workflow/.tasker/`](../examples/blog-post-workflow/.tasker/)

## Purpose

`.tasker/` is the **source of truth** for a Tasker project that lives inside a
code repository. It replaces the cloud database as the master copy: the repo
holds the project, and Tasker is a *lens* over it (local MCP for agents, a
localhost web app for humans). The cloud backend, if used, becomes an optional
sync target — never the master.

Design priorities, in order:

1. **Clean git diffs** — editing one task touches one small file.
2. **Mergeable** — two agents/people editing different tasks don't collide.
3. **Human-editable** — a developer can edit a task in their editor without tooling.
4. **Round-trips losslessly** — DB → `.tasker/` → DB produces identical data.

One repo = one project. There is no project picker at the local level.

---

## Directory layout

```
.tasker/
├── project.json          # structure: prefix, sections, groups, flow names, id counter
└── tasks/
    ├── BPW-1.md          # one file per task, named by short ID
    ├── BPW-2.md
    └── …
```

- `project.json` holds everything structural and few-in-number (sections, groups,
  flow names, the ID counter). Editing structure is rare, so the churn of a single
  shared file is acceptable here.
- `tasks/` holds one Markdown file per task. Tasks are many and edited often, so
  they are split to keep diffs and merges local.
- Task files live **flat** in `tasks/` (not nested by section). A task's section
  lives in its frontmatter, so moving a task between sections is a one-line edit,
  not a file move.

---

## `project.json`

```json
{
  "version": 1,
  "name": "Blog Post Workflow",
  "prefix": "BPW",
  "next_short_id": 31,
  "sections": [
    { "id": "planning", "name": "Planning", "order": 20 }
  ],
  "groups": [
    { "id": "research", "name": "Research", "section": "planning", "order": 10 }
  ],
  "flows": {
    "BPW-4": "Publishing Pipeline"
  }
}
```

| Field | Type | Notes |
|---|---|---|
| `version` | int | Format version. Currently `1`. Enables future migrations. |
| `name` | string | Human display name of the project. |
| `prefix` | string | 2–4 uppercase letters used in short IDs (`BPW-4`). Derived from `name` if absent — see [Prefix derivation](#prefix-derivation). |
| `next_short_id` | int | Monotonic counter for the next task's short ID. Never decreases; deleted IDs are retired, never reused. |
| `sections[]` | array | Ordered sections. |
| `sections[].id` | slug | **Stable identifier.** Set once; never changes on rename. Tasks reference this. |
| `sections[].name` | string | Display name. Safe to rename freely. |
| `sections[].order` | int | Sparse sort key (10, 20, 30…) — see [Ordering](#ordering). |
| `groups[]` | array | Optional groups within sections. |
| `groups[].id` | slug | Stable identifier; never changes on rename. |
| `groups[].name` | string | Display name. |
| `groups[].section` | slug | The `id` of the section this group belongs to. |
| `groups[].order` | int | Sparse sort key, scoped within the section. |
| `flows` | object | Map of **flow root task short ID → human flow name**. Only flows the user has named appear here; unnamed flows fall back to an auto-generated name at render time. |

### Why stable slug IDs (not UUIDs, not names)

- **UUIDs** are unreadable in git diffs and task frontmatter.
- **Names** break every reference when renamed.
- A **slug `id` that's fixed at creation** is readable *and* rename-safe. `name`
  is purely cosmetic. Renaming "Planning" → "Ideation" changes one `name` field;
  no task file changes.

---

## Task file — `tasks/<SHORT_ID>.md`

Markdown with a YAML frontmatter block. Frontmatter holds structured fields;
the body (everything after the closing `---`) is the free-form context/notes.

```markdown
---
id: BPW-11
title: Write first draft
status: in_progress
priority: high
section: writing
group: drafting
due: 2026-06-10
order: 10
input:
  from: BPW-4
output: First draft document
milestones:
  - { text: "Outline reviewed", done: true }
  - { text: "Intro drafted",    done: false }
---

Free-form context and notes live here. This maps to the legacy `detail` field.
Prose belongs in the body, not crammed into JSON.
```

| Field | Required | Type | Notes |
|---|---|---|---|
| `id` | yes | string | Full short ID (`BPW-11`). Must match the filename. |
| `title` | yes | string | The task text. |
| `status` | yes | enum | `pending` \| `in_progress` \| `done`. |
| `priority` | yes | enum | `rush` \| `high` \| `medium` \| `low`. |
| `section` | yes | slug | References `project.json.sections[].id`. |
| `group` | no | slug | References `project.json.groups[].id`. **Omitted when ungrouped.** |
| `due` | no | date | `YYYY-MM-DD`. Omitted when none. |
| `order` | yes | int | Sparse sort key within the section/group. |
| `input` | no | object | The task's upstream dependency. Omitted when none. |
| `input.from` | — | string | Short ID of the task whose output this task consumes. **This is the flow edge.** |
| `output` | no | string | Description of what this task produces for downstream tasks. |
| `milestones` | no | array | Inline checklist. Each item is `{ text, done }`. Omitted when none. |
| *(body)* | no | markdown | Free-form context/notes. The legacy `detail` field. |

**Omit, don't null.** Optional fields with no value are left out entirely rather
than written as `null`/`""`. This keeps the common minimal task to ~6 lines and
keeps diffs meaningful (a field appearing *is* the signal it was set).

---

## Prefix derivation

When `project.json.prefix` is absent or empty, derive it from `name`:

1. Strip non-alphanumeric characters; split `name` into words on whitespace.
2. **Multi-word name** → take the first letter of each word, uppercase, keep the
   first 2–4 letters.
   `"Blog Post Workflow"` → `BPW`. `"Customer Support Portal Revamp"` → `CSPR`.
3. **Single-word name** → uppercase, take the first 3 letters (prefer dropping
   vowels after the first letter if the word is long).
   `"Tasker"` → `TSK`. `"Api"` → `API`.
4. Sanitize to `A–Z` only; if the result is empty, fall back to `TSK`.
5. Persist the derived value back into `project.json.prefix` so it's stable from
   then on (derivation runs once, not on every load).

Local uniqueness is not required — one repo holds one project, so prefixes never
collide. The cloud/team tier handles cross-project uniqueness separately.

---

## Short ID assignment

- A new task gets `id = "<prefix>-<next_short_id>"`, then `next_short_id` is
  incremented in `project.json`.
- IDs are never reused. Deleting `BPW-7` deletes the file; `BPW-7` is retired.
- The filename is `<id>.md`. Renaming the project prefix is a migration that
  renames every task file and rewrites every `id`/`input.from` reference — rare,
  treated as an explicit operation.

---

## Flow derivation

Flows are not stored explicitly. They are **derived from `input.from` edges**:

1. Build a directed graph: for every task with `input.from`, add an edge
   `from → task`.
2. Find connected components (treating edges as undirected for grouping).
3. Each component with at least one edge is a **flow**. Isolated tasks are not
   flows.
4. The flow's **root** is the component member with no incoming `input.from`.
5. The flow's **name** = `project.json.flows[rootId]` if present, else an
   auto-generated name (e.g. derived from the root task's title).

This is the same logic as the current Blueprint `detectFlows`, so it ports
directly. Because edges live on the consuming task, creating or removing a
dependency is always a one-line, one-file change.

---

## Ordering

`order` is a **sparse integer** sort key (10, 20, 30…), scoped within its parent
(sections within the project; groups within a section; tasks within a
section/group).

- Sparse gaps let a task be inserted between two others by picking a value
  between them — without renumbering siblings, so a reorder touches one file.
- When gaps run out (rare), a normalization pass rewrites the affected siblings
  back to 10, 20, 30…. This is the only operation that intentionally churns
  multiple files, and it's infrequent.

---

## Validation rules

A `.tasker/` is valid when:

- `project.json` parses and has `version`, `name`, `prefix`, `next_short_id`.
- Every task file's `id` matches its filename and is unique.
- Every task's `section` resolves to a section `id`; every `group` (if present)
  resolves to a group `id` whose `section` matches the task's `section`.
- Every `input.from` resolves to an existing task `id`.
- `status` and `priority` are within their enums.
- The `input.from` graph is acyclic (no task depends on itself transitively).

Implementations should treat a dangling `input.from` or an unknown `section`/
`group` as a soft warning (render the task, surface the problem) rather than a
hard failure — repos get hand-edited.

---

## Known edge cases / open questions

- **Counter merge conflicts:** two agents creating tasks simultaneously both bump
  `next_short_id` → a conflict in `project.json`. Acceptable for local
  single-agent use; the team/cloud tier needs a real ID-allocation strategy.
- **Flow-name orphaning:** names are keyed by the root task's ID. If edits change
  which task is the root, the stored name orphans. Matches current behavior;
  consider keying flows by a stable flow ID in a future version.
- **Prefix rename** is a multi-file migration (see [Short ID assignment](#short-id-assignment)).
- **Cycles** are invalid but easy to create by hand-editing; the loader must
  detect and report them rather than infinite-loop during flow derivation.
