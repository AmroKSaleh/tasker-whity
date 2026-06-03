-- Fix: task_discussions.checked_steps is jsonb (not boolean[]).
-- Rewrites all three milestone RPCs to use jsonb operations end-to-end.

CREATE OR REPLACE FUNCTION append_milestone(
  p_task_id uuid,
  p_user_id uuid,
  p_text text
) RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_id uuid;
  v_step jsonb := jsonb_build_object('summary', p_text, 'detail', '');
BEGIN
  SELECT id INTO v_id FROM task_discussions WHERE task_id = p_task_id FOR UPDATE;
  IF v_id IS NULL THEN
    INSERT INTO task_discussions (task_id, user_id, steps, checked_steps, messages)
    VALUES (p_task_id, p_user_id, jsonb_build_array(v_step), jsonb_build_array(false), '[]'::jsonb);
  ELSE
    UPDATE task_discussions
    SET
      steps = COALESCE(steps, '[]'::jsonb) || v_step,
      checked_steps = COALESCE(checked_steps, '[]'::jsonb) || jsonb_build_array(false),
      updated_at = NOW()
    WHERE id = v_id;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION set_milestone_checked(
  p_task_id uuid,
  p_index int,
  p_checked boolean
) RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_disc task_discussions;
  v_checked jsonb;
  v_steps_len int;
BEGIN
  SELECT * INTO v_disc FROM task_discussions WHERE task_id = p_task_id FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  v_steps_len := COALESCE(jsonb_array_length(v_disc.steps), 0);
  IF p_index < 0 OR p_index >= v_steps_len THEN RETURN NULL; END IF;

  v_checked := COALESCE(v_disc.checked_steps, '[]'::jsonb);
  WHILE COALESCE(jsonb_array_length(v_checked), 0) < v_steps_len LOOP
    v_checked := v_checked || jsonb_build_array(false);
  END LOOP;
  v_checked := jsonb_set(v_checked, ARRAY[p_index::text], to_jsonb(p_checked));

  UPDATE task_discussions
  SET checked_steps = v_checked, updated_at = NOW()
  WHERE id = v_disc.id;

  RETURN COALESCE(v_disc.steps->p_index->>'summary', v_disc.steps->>p_index);
END;
$$;

CREATE OR REPLACE FUNCTION delete_milestone_at(
  p_task_id uuid,
  p_index int
) RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_disc task_discussions;
  v_label text;
  v_new_steps jsonb := '[]'::jsonb;
  v_new_checked jsonb := '[]'::jsonb;
  v_steps_len int;
  i int;
BEGIN
  SELECT * INTO v_disc FROM task_discussions WHERE task_id = p_task_id FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  v_steps_len := COALESCE(jsonb_array_length(v_disc.steps), 0);
  IF p_index < 0 OR p_index >= v_steps_len THEN RETURN NULL; END IF;

  v_label := COALESCE(v_disc.steps->p_index->>'summary', v_disc.steps->>p_index);

  FOR i IN 0..v_steps_len-1 LOOP
    IF i <> p_index THEN
      v_new_steps := v_new_steps || jsonb_build_array(v_disc.steps->i);
      v_new_checked := v_new_checked || jsonb_build_array(COALESCE((v_disc.checked_steps->>i)::boolean, false));
    END IF;
  END LOOP;

  UPDATE task_discussions
  SET steps = v_new_steps, checked_steps = v_new_checked, updated_at = NOW()
  WHERE id = v_disc.id;

  RETURN v_label;
END;
$$;