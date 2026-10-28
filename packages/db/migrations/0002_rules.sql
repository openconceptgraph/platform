-- Rules the database keeps itself, so no application bug can break them:
-- IDs are permanent; content changes are counted and sent back to review;
-- "needs" never loops; the judgement record is append-only.

-- Register each new base object in the ID registry, under its kind.
CREATE FUNCTION ocg_register_object() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO base_object (id, kind) VALUES (NEW.id, TG_ARGV[0]::object_kind);
  RETURN NEW;
END $$;
--> statement-breakpoint

-- On update: the ID cannot change; a change of content raises the revision
-- and, where the object has a review status, returns it to "proposed",
-- because what a reviewer judged is no longer what is stored.
CREATE FUNCTION ocg_touch_object() RETURNS trigger
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
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint

CREATE FUNCTION ocg_forbid_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% % is permanent and cannot be deleted', TG_TABLE_NAME, OLD.id
    USING ERRCODE = 'integrity_constraint_violation',
          HINT = 'Retire it: set base_object.retired_at and add a replaced-by link.';
END $$;
--> statement-breakpoint

CREATE FUNCTION ocg_forbid_truncate() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% cannot be truncated', TG_TABLE_NAME
    USING ERRCODE = 'integrity_constraint_violation';
END $$;
--> statement-breakpoint

-- In the registry only retired_at may change.
CREATE FUNCTION ocg_guard_registry() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'base_object %: only retired_at may change', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint

CREATE TRIGGER base_object_guard BEFORE UPDATE ON base_object
  FOR EACH ROW EXECUTE FUNCTION ocg_guard_registry();
--> statement-breakpoint
CREATE TRIGGER base_object_no_delete BEFORE DELETE ON base_object
  FOR EACH ROW EXECUTE FUNCTION ocg_forbid_delete();
--> statement-breakpoint
CREATE TRIGGER base_object_no_truncate BEFORE TRUNCATE ON base_object
  FOR EACH STATEMENT EXECUTE FUNCTION ocg_forbid_truncate();
--> statement-breakpoint

-- Every table of registered objects gets the same three triggers. A test
-- checks that no such table is missing them.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'framework', 'education_level', 'document', 'node', 'statement', 'teaching_plan', 'placement',
    'family', 'concept', 'level', 'misconception', 'link', 'source'
  ] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION ocg_register_object(%L)', t || '_register', t, t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION ocg_touch_object()', t || '_touch', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION ocg_forbid_delete()', t || '_no_delete', t);
  END LOOP;
END $$;
--> statement-breakpoint

-- "needs" never loops. Runs after the row is final (so after ocg_touch_object
-- has settled its status) and takes a lock, so two concurrent writers cannot
-- close a loop between them. Rejected links are not part of the graph.
CREATE FUNCTION ocg_needs_acyclic() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.link_type <> 'needs' OR NEW.status = 'rejected' THEN
    RETURN NULL;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('ocg_needs_acyclic'));
  IF EXISTS (
    WITH RECURSIVE reachable(id) AS (
      SELECT NEW.to_id
      UNION
      SELECT l.to_id FROM link l JOIN reachable r ON l.from_id = r.id
      WHERE l.link_type = 'needs' AND l.status <> 'rejected'
    )
    SELECT 1 FROM reachable WHERE id = NEW.from_id
  ) THEN
    RAISE EXCEPTION 'needs link % -> % would make a loop', NEW.from_id, NEW.to_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint

CREATE TRIGGER link_needs_acyclic AFTER INSERT OR UPDATE ON link
  FOR EACH ROW EXECUTE FUNCTION ocg_needs_acyclic();
--> statement-breakpoint

-- A judgement is stamped by the database, must be on the object's current
-- revision, and takes its control flag from its batch, never from the caller.
CREATE FUNCTION ocg_judgement_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  current_revision integer;
  batch_closed_at timestamptz;
BEGIN
  NEW.created_at := now();

  EXECUTE format('SELECT revision FROM %I WHERE id = $1', NEW.object_kind)
    INTO current_revision USING NEW.object_id;
  IF current_revision IS DISTINCT FROM NEW.object_revision THEN
    RAISE EXCEPTION 'judgement is on revision % of % %, which is now at revision %',
      NEW.object_revision, NEW.object_kind, NEW.object_id, current_revision
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.batch_id IS NULL THEN
    NEW.is_control := false;
  ELSE
    SELECT i.control_expected IS NOT NULL, b.closed_at
      INTO NEW.is_control, batch_closed_at
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
  END IF;

  RETURN NEW;
END $$;
--> statement-breakpoint

CREATE FUNCTION ocg_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME
    USING ERRCODE = 'integrity_constraint_violation',
          HINT = 'Record a new judgement that supersedes this one.';
END $$;
--> statement-breakpoint

CREATE TRIGGER judgement_insert BEFORE INSERT ON judgement
  FOR EACH ROW EXECUTE FUNCTION ocg_judgement_insert();
--> statement-breakpoint
CREATE TRIGGER judgement_append_only BEFORE UPDATE OR DELETE ON judgement
  FOR EACH ROW EXECUTE FUNCTION ocg_append_only();
--> statement-breakpoint
CREATE TRIGGER judgement_no_truncate BEFORE TRUNCATE ON judgement
  FOR EACH STATEMENT EXECUTE FUNCTION ocg_forbid_truncate();
