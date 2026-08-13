-- TDE-300: unified, TYPED seed checklist.
--
-- A seed (flow or task) now carries ONE checklist instead of two parallel lists
-- (open_questions + milestones). Both fold into task_discussions.steps as typed
-- milestone items:
--   kind = 'question'      → answered WITH the user during the resolution interview
--   kind = 'prerequisite'  → work that should be done BEFORE the seed is resolved
--                            (soft-gated at resolve_seed / build_new_flow)
--   kind = NULL            → a plain milestone (normal tasks, unchanged behaviour)
--
-- WHY MERGED: the only thing that justified keeping open_questions and prerequisites
-- as SEPARATE primitives was differentiated downstream behaviour — auto-feeding an
-- answered question into a flow's design vs. wiring a prerequisite's output as a flow
-- input. That behaviour was deferred (premature until the bootstrap→build-flow loop is
-- exercised for real). With nothing consuming the distinction, two lists + two gates
-- was over-engineering; one soft-gated checklist is simpler to author and to read.
-- The `kind` tag is RETAINED (inert today) so that future auto-wiring can re-introduce
-- differentiated behaviour without a data migration or a re-interview of every seed.
--
-- append_milestone_kind mirrors append_milestone (atomic_milestones_fix.sql) but stamps
-- an optional `kind` onto the step object. checked_steps remains a parallel jsonb bool
-- array, so existing milestone RPCs (set_milestone_checked, delete_milestone_at) and the
-- frontend checklist keep working untouched.

CREATE OR REPLACE FUNCTION append_milestone_kind(
  p_task_id uuid,
  p_user_id uuid,
  p_text text,
  p_kind text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_id uuid;
  v_step jsonb := jsonb_build_object('summary', p_text, 'detail', '');
BEGIN
  IF p_kind IS NOT NULL THEN
    v_step := v_step || jsonb_build_object('kind', p_kind);
  END IF;
  SELECT id INTO v_id FROM task_discussions WHERE task_id = p_task_id FOR UPDATE;
  IF v_id IS NULL THEN
    INSERT INTO task_discussions (task_id, user_id, steps, checked_steps, messages)
    VALUES (p_task_id, p_user_id, jsonb_build_array(v_step), jsonb_build_array(false), '[]'::jsonb);
  ELSE
    UPDATE task_discussions
    SET steps = COALESCE(steps, '[]'::jsonb) || v_step,
        checked_steps = COALESCE(checked_steps, '[]'::jsonb) || jsonb_build_array(false),
        updated_at = NOW()
    WHERE id = v_id;
  END IF;
END;
$$;
