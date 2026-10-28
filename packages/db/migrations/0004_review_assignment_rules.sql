-- The judgement trigger gains two rules: only a batch's assigned reviewer may
-- judge in it, and a judgement covered by another (made on that object's
-- screen) belongs to the same reviewer and takes its control flag from it.
CREATE OR REPLACE FUNCTION ocg_judgement_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  current_revision integer;
  batch_closed_at timestamptz;
  batch_reviewer text;
  primary_reviewer text;
  primary_covered_by uuid;
BEGIN
  NEW.created_at := now();

  EXECUTE format('SELECT revision FROM %I WHERE id = $1', NEW.object_kind)
    INTO current_revision USING NEW.object_id;
  IF current_revision IS DISTINCT FROM NEW.object_revision THEN
    RAISE EXCEPTION 'judgement is on revision % of % %, which is now at revision %',
      NEW.object_revision, NEW.object_kind, NEW.object_id, current_revision
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.covered_by_id IS NOT NULL THEN
    SELECT p.reviewer_id, p.is_control, p.covered_by_id
      INTO primary_reviewer, NEW.is_control, primary_covered_by
      FROM judgement p WHERE p.id = NEW.covered_by_id;
    IF primary_reviewer IS DISTINCT FROM NEW.reviewer_id THEN
      RAISE EXCEPTION 'a covered judgement must be by the reviewer of the judgement covering it'
        USING ERRCODE = 'check_violation';
    END IF;
    IF primary_covered_by IS NOT NULL THEN
      RAISE EXCEPTION 'judgement % is itself covered by another', NEW.covered_by_id
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.batch_id IS NULL THEN
    NEW.is_control := false;
  ELSE
    SELECT i.control_expected IS NOT NULL, b.closed_at, b.assigned_to
      INTO NEW.is_control, batch_closed_at, batch_reviewer
      FROM batch_item i JOIN batch b ON b.id = i.batch_id
     WHERE i.batch_id = NEW.batch_id AND i.object_id = NEW.object_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION '% % is not in batch %', NEW.object_kind, NEW.object_id, NEW.batch_id
        USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF batch_closed_at IS NOT NULL THEN
      RAISE EXCEPTION 'batch % closed at %', NEW.batch_id, batch_closed_at
        USING ERRCODE = 'check_violation';
    END IF;
    IF batch_reviewer <> NEW.reviewer_id THEN
      RAISE EXCEPTION 'batch % is assigned to another reviewer', NEW.batch_id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END $$;
