-- A planted control stays marked for good, and goes to reviewers only as a
-- control: a batch item for a planted object always carries its expected
-- decision, whatever the caller says.

CREATE FUNCTION ocg_planted_permanent() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'planted controls stay marked for good'
    USING ERRCODE = 'integrity_constraint_violation';
END $$;
--> statement-breakpoint

CREATE TRIGGER planted_permanent BEFORE UPDATE OR DELETE ON planted
  FOR EACH ROW EXECUTE FUNCTION ocg_planted_permanent();
--> statement-breakpoint
CREATE TRIGGER planted_no_truncate BEFORE TRUNCATE ON planted
  FOR EACH STATEMENT EXECUTE FUNCTION ocg_forbid_truncate();
--> statement-breakpoint

CREATE FUNCTION ocg_batch_item_planted() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  p planted%ROWTYPE;
BEGIN
  SELECT * INTO p FROM planted WHERE object_id = NEW.object_id;
  IF FOUND THEN
    NEW.control_expected := p.expected;
    NEW.control_note := coalesce(NEW.control_note, p.note);
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint

CREATE TRIGGER batch_item_planted BEFORE INSERT OR UPDATE ON batch_item
  FOR EACH ROW EXECUTE FUNCTION ocg_batch_item_planted();
--> statement-breakpoint

-- "needs" never loops, counting only the real graph: planted links are left
-- out, so a planted control can never block a genuine link. The check now runs
-- at commit, when it can see whether the transaction marked a link as planted,
-- and reads the link as the transaction left it.
CREATE OR REPLACE FUNCTION ocg_needs_acyclic() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  l link%ROWTYPE;
BEGIN
  SELECT * INTO l FROM link WHERE id = NEW.id;
  IF l.link_type <> 'needs' OR l.status = 'rejected'
     OR EXISTS (SELECT 1 FROM planted WHERE object_id = l.id) THEN
    RETURN NULL;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('ocg_needs_acyclic'));
  IF EXISTS (
    WITH RECURSIVE reachable(id) AS (
      SELECT l.to_id
      UNION
      SELECT n.to_id FROM link n JOIN reachable r ON n.from_id = r.id
      WHERE n.link_type = 'needs' AND n.status <> 'rejected'
        AND NOT EXISTS (SELECT 1 FROM planted p WHERE p.object_id = n.id)
    )
    SELECT 1 FROM reachable WHERE id = l.from_id
  ) THEN
    RAISE EXCEPTION 'needs link % -> % would make a loop', l.from_id, l.to_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint

DROP TRIGGER link_needs_acyclic ON link;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER link_needs_acyclic AFTER INSERT OR UPDATE ON link
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ocg_needs_acyclic();
