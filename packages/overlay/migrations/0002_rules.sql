-- Rules the workspace database keeps itself.

-- An alignment carries only a type its artefact's kind allows (the client
-- profile's own list), whichever of the three changes: the alignment, the
-- artefact's kind, or the kind's list.
CREATE FUNCTION overlay.require_allowed_alignment() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  this_alignment uuid;
  this_artefact uuid;
  this_kind text;
  bad record;
BEGIN
  -- Each table's own key; a field another table lacks is never named.
  IF TG_TABLE_NAME = 'alignment' THEN
    this_alignment := NEW.id;
  ELSIF TG_TABLE_NAME = 'artefact' THEN
    this_artefact := NEW.id;
  ELSE
    this_kind := NEW.kind;
  END IF;
  SELECT al.id, al.alignment_type, a.kind INTO bad
    FROM overlay.alignment al
    JOIN overlay.artefact a ON a.id = al.artefact_id
    JOIN overlay.artefact_kind k ON k.kind = a.kind
   WHERE NOT (al.alignment_type = ANY (k.alignments))
     AND (al.id = this_alignment OR a.id = this_artefact OR k.kind = this_kind)
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'an artefact of kind % may not carry a % alignment (alignment %): the client profile does not allow it',
      bad.kind, bad.alignment_type, bad.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER alignment_allowed AFTER INSERT OR UPDATE ON overlay.alignment
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION overlay.require_allowed_alignment();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER artefact_kind_allows_its_alignments AFTER UPDATE OF kind ON overlay.artefact
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION overlay.require_allowed_alignment();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER kind_keeps_alignments_in_use AFTER UPDATE OF alignments ON overlay.artefact_kind
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION overlay.require_allowed_alignment();
--> statement-breakpoint

-- updated_at follows a change of content; created_at never changes.
CREATE FUNCTION overlay.touch() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.created_at := OLD.created_at;
  IF (to_jsonb(NEW) - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'updated_at') THEN
    NEW.updated_at := now();
  ELSE
    NEW.updated_at := OLD.updated_at;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER profile_touch BEFORE UPDATE ON overlay.profile FOR EACH ROW EXECUTE FUNCTION overlay.touch();
--> statement-breakpoint
CREATE TRIGGER artefact_touch BEFORE UPDATE ON overlay.artefact FOR EACH ROW EXECUTE FUNCTION overlay.touch();
--> statement-breakpoint
CREATE TRIGGER alignment_touch BEFORE UPDATE ON overlay.alignment FOR EACH ROW EXECUTE FUNCTION overlay.touch();
--> statement-breakpoint
CREATE TRIGGER plan_touch BEFORE UPDATE ON overlay.plan FOR EACH ROW EXECUTE FUNCTION overlay.touch();
--> statement-breakpoint
CREATE TRIGGER placement_touch BEFORE UPDATE ON overlay.placement FOR EACH ROW EXECUTE FUNCTION overlay.touch();
