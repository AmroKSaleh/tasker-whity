-- Atomic milestone operations: replace read-modify-write on task_discussions.steps/checked_steps
-- with row-locked Postgres functions so concurrent calls don't clobber each other.

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
    VALUES (p_task_id, p_user_id, jsonb_build_array(v_step), ARRAY[false]::boolean[], '[]'::jsonb);
  ELSE
    UPDATE task_discussions
    SET
      steps = COALESCE(steps, '[]'::jsonb) || v_step,
      checked_steps = COALESCE(checked_steps, ARRAY[]::boolean[]) || ARRAY[false]::boolean[],
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
  v_checked boolean[];
  v_steps_len int;
BEGIN
  SELECT * INTO v_disc FROM task_discussions WHERE task_id = p_task_id FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  v_steps_len := COALESCE(jsonb_array_length(v_disc.steps), 0);
  IF p_index < 0 OR p_index >= v_steps_len THEN RETURN NULL; END IF;

  v_checked := COALESCE(v_disc.checked_steps, ARRAY[]::boolean[]);
  WHILE COALESCE(array_length(v_checked, 1), 0) < v_steps_len LOOP
    v_checked := v_checked || false;
  END LOOP;
  v_checked[p_index + 1] := p_checked;

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
  v_new_checked boolean[] := ARRAY[]::boolean[];
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
      v_new_checked := v_new_checked || COALESCE(v_disc.checked_steps[i+1], false);
    END IF;
  END LOOP;

  UPDATE task_discussions
  SET steps = v_new_steps, checked_steps = v_new_checked, updated_at = NOW()
  WHERE id = v_disc.id;

  RETURN v_label;
END;
$$;