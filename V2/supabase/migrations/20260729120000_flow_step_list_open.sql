-- Honest flow progress when steps are discovered mid-run (TDE-811).
--
-- THE BUG: run_flow computed `allDone = completedCount === sorted.length`, printed
-- "Status: COMPLETE — all steps done." and RETURNED EARLY. advance_guide did the same
-- ("Flow complete — all steps done."). Some operations legitimately do not know their full
-- step list at the start — research and investigation discover the next step as they go — so
-- that condition fires at EVERY pause. Finish step 1 of an eventual 5 and the flow declares
-- itself complete, then silently reverts to in-progress when step 2 is added. Worse than an
-- imprecise number: an agent reading COMPLETE stops working.
--
-- WHAT WAS *NOT* WRONG: the denominator. It is computed live everywhere (MCP reads the
-- current task list; the web app uses steps.length) and no stored step count exists — the
-- flows table has never had one. TDE-811's third milestone assumed a count "frozen at start"
-- and there is no such thing. The fraction already tracks additions correctly.
--
-- THE FIX: one mutable fact per flow — is its step list still open? This is deliberately NOT
-- a flow "type" (Q6 / TDE-798 refused those, and rightly: nothing here branches on a category
-- of flow). It is a statement about what is currently KNOWN, it can flip either way during a
-- single run, and it does not change how the flow executes — only whether the system is
-- entitled to call the flow finished.
--
-- DEFAULT false = "the step list is settled", because most flows are authored whole by
-- build_new_flow with their steps known. Defaulting to open would make every readout hedge
-- and would tax the common case to serve the uncommon one.

alter table flows add column if not exists step_list_open boolean not null default false;

comment on column flows.step_list_open is
  'TDE-811: true when this flow does not yet know its full step list (discovery-shaped work). While true, run_flow and advance_guide must NOT declare the flow complete or return early on done==known — more steps are expected. Not a flow type: a mutable fact about current knowledge, settable both ways mid-run.';
