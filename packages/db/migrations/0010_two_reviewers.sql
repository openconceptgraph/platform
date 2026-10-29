CREATE TYPE "public"."review_stage" AS ENUM('review', 'confirmation');--> statement-breakpoint
ALTER TABLE "batch" ADD COLUMN "stage" "review_stage" DEFAULT 'review' NOT NULL;--> statement-breakpoint

-- Two reviewers confirm (ADR-032, amending ADR-028). Counting each reviewer's
-- latest judgement on the object's current revision: confirmed when every one
-- confirms and at least two different reviewers have; rejected when every one
-- rejects; otherwise proposed (waiting for a second reviewer, a change was
-- asked for, or reviewers disagree). One rejection is enough, because a
-- rejected item never reaches a release. Judgements on planted controls never
-- count.
CREATE OR REPLACE FUNCTION ocg_derive_status(kind object_kind, object uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  reviewers_to_confirm CONSTANT integer := 2;
  current_revision integer;
  confirms integer;
  rejects integer;
  total integer;
  confirmers integer;
  derived review_status;
BEGIN
  EXECUTE format('SELECT revision FROM %I WHERE id = $1', kind) INTO current_revision USING object;

  SELECT count(*) FILTER (WHERE j.decision = 'confirm'),
         count(*) FILTER (WHERE j.decision = 'reject'),
         count(*),
         count(DISTINCT j.reviewer_id) FILTER (WHERE j.decision = 'confirm')
    INTO confirms, rejects, total, confirmers
    FROM judgement j
   WHERE j.object_id = object
     AND j.object_revision = current_revision
     AND NOT j.is_control
     AND NOT EXISTS (SELECT 1 FROM judgement later WHERE later.supersedes_id = j.id);
  IF total = 0 THEN
    RETURN;
  END IF;

  derived := CASE
    WHEN confirms = total AND confirmers >= reviewers_to_confirm THEN 'confirmed'
    WHEN rejects = total THEN 'rejected'
    ELSE 'proposed'
  END;

  PERFORM set_config('ocg.deriving_status', 'on', true);
  EXECUTE format('UPDATE %I SET status = $1 WHERE id = $2 AND status IS DISTINCT FROM $1', kind)
    USING derived, object;
  PERFORM set_config('ocg.deriving_status', 'off', true);
END $$;
--> statement-breakpoint

-- Judgements recorded under the one-reviewer rule.
SELECT ocg_derive_status(j.object_kind, j.object_id)
  FROM (SELECT DISTINCT object_kind, object_id FROM judgement
         WHERE object_kind IN ('family', 'concept', 'level', 'misconception', 'link')) j;
