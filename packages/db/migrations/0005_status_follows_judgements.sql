-- An object's review status follows its reviewers' judgements, and nothing
-- else may set it. Counting each reviewer's latest judgement on the object's
-- current revision: confirmed when every one confirms, rejected when every one
-- rejects, otherwise proposed (a change was asked for, or reviewers disagree).
-- Judgements on planted controls never count: they measure the reviewer, not
-- the base, so a planted item can never be confirmed into a release.

-- Status may change only when content changes (back to proposed) or when
-- ocg_judgement_status derives it.
CREATE OR REPLACE FUNCTION ocg_touch_object() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  bookkeeping CONSTANT text[] := ARRAY['revision', 'status', 'created_at', 'updated_at'];
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'object IDs are permanent: % cannot become %', OLD.id, NEW.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  NEW.created_at := OLD.created_at;
  NEW.updated_at := now();
  IF (to_jsonb(NEW) - bookkeeping) IS DISTINCT FROM (to_jsonb(OLD) - bookkeeping) THEN
    NEW.revision := OLD.revision + 1;
    IF to_jsonb(OLD) ? 'status' THEN
      NEW := jsonb_populate_record(NEW, '{"status": "proposed"}'::jsonb);
    END IF;
  ELSE
    NEW.revision := OLD.revision;
    IF to_jsonb(NEW) -> 'status' IS DISTINCT FROM to_jsonb(OLD) -> 'status'
       AND current_setting('ocg.deriving_status', true) IS DISTINCT FROM 'on' THEN
      RAISE EXCEPTION '% %: a review status follows judgements and cannot be set directly', TG_TABLE_NAME, OLD.id
        USING ERRCODE = 'integrity_constraint_violation',
              HINT = 'Record a judgement instead.';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint

-- Derives one object's status from its judgements. Leaves it alone when no
-- judgement counts (none yet, or only planted-control ones).
CREATE FUNCTION ocg_derive_status(kind object_kind, object uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  current_revision integer;
  confirms integer;
  rejects integer;
  total integer;
  derived review_status;
BEGIN
  EXECUTE format('SELECT revision FROM %I WHERE id = $1', kind) INTO current_revision USING object;

  SELECT count(*) FILTER (WHERE j.decision = 'confirm'),
         count(*) FILTER (WHERE j.decision = 'reject'),
         count(*)
    INTO confirms, rejects, total
    FROM judgement j
   WHERE j.object_id = object
     AND j.object_revision = current_revision
     AND NOT j.is_control
     AND NOT EXISTS (SELECT 1 FROM judgement later WHERE later.supersedes_id = j.id);
  IF total = 0 THEN
    RETURN;
  END IF;

  derived := CASE
    WHEN confirms = total THEN 'confirmed'
    WHEN rejects = total THEN 'rejected'
    ELSE 'proposed'
  END;

  PERFORM set_config('ocg.deriving_status', 'on', true);
  EXECUTE format('UPDATE %I SET status = $1 WHERE id = $2 AND status IS DISTINCT FROM $1', kind)
    USING derived, object;
  PERFORM set_config('ocg.deriving_status', 'off', true);
END $$;
--> statement-breakpoint

CREATE FUNCTION ocg_judgement_status() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Only these kinds carry a review status.
  IF NOT NEW.is_control AND NEW.object_kind IN ('family', 'concept', 'level', 'misconception', 'link') THEN
    PERFORM ocg_derive_status(NEW.object_kind, NEW.object_id);
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint

CREATE TRIGGER judgement_status AFTER INSERT ON judgement
  FOR EACH ROW EXECUTE FUNCTION ocg_judgement_status();
--> statement-breakpoint

-- Judgements recorded before this rule existed.
SELECT ocg_derive_status(j.object_kind, j.object_id)
  FROM (SELECT DISTINCT object_kind, object_id FROM judgement
         WHERE object_kind IN ('family', 'concept', 'level', 'misconception', 'link')) j;
