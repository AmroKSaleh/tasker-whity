# MCP+UI: Seed mechanic + bootstrap population phase

_KB entry · source: agent · READ-ONLY mirror (edit via create_kb_entry/update_kb_entry over MCP)._

Shipped the unified Seed mechanic + bootstrap_project population phase (extends the TDE-262 Foundation work).

DATA MODEL (migration 20260620120000_task_seeds.sql): tasks gained `kind` ('normal'|'seed'), `seed_target` ('task'|'flow'), `seed_open_questions` jsonb (string[]), `spawned_from_seed_id` uuid → tasks(id) (provenance on the spawned artifact). resolveTask() select lists were extended with these + section_id (was previously omitting them).

WHAT A SEED IS: a task whose deliverable is ANOTHER artifact, produced once the user resolves its open context. Two targets:
- context seed (target 'task') → resolved via resolve_seed
- flow seed (target 'flow') → resolved via build_new_flow

MCP CHANGES:
- create_task accepts kind/seed_target/open_questions (validates a seed has a target).
- NEW resolve_seed(seed_id, task_spec): atomically creates the concrete task from the spec, places it (defaults to seed's section), appends milestones, marks the seed done, sets spawned_from_seed_id. Rejects flow seeds (those go through build_new_flow).
- get_task: loud "⚑ THIS IS A SEED" banner with target + open_questions + resolve instructions, so the agent resolves rather than works it. Also notes spawned-from-seed provenance.
- get_project: task badges show "SEED→task/flow".
- bootstrap_project playbook: added step 5 POPULATE (opt-in, after Foundation+IS) with a `population` block — three buckets (concrete task / flow seed / context seed) + KB-from-decisions, one ratify pass, restraint note (be sparing, avoid seed graveyard; "Needs Context" section ≠ Backlog).

UI (web app = inspector; resolution itself happens via the agent, NOT in-browser — consistent with AI-native thesis):
- BoardCard: seeds get a dashed accent border + "⚑ Seed → target" pill.
- TaskDetailPanel: seed banner with open questions + "resolve with your agent" hint (resolve_seed / build_new_flow); "↳ created from a resolved seed" line on spawned tasks.
- NOT added: in-browser resolution wizard (off-thesis), seed banner in TaskDetailSheet (mobile — card badge still shows), explicit seed-count surfacing. Candidates if needed later.

Emerging Tasker idiom: capture insight at peak context, defer commitment until it can be done well (same shape as the Conductor's parked intakes, see [[design_conductor_per_connector]]). Seeds = staged work; resolve = spawn the real artifact with provenance (same provenance pattern as Conductor's tasks.intake_source).
