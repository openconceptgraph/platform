-- A transcription check is a record, like a judgement: append-only. A check
-- found to be wrong is answered by a new check, never by editing the old one.

CREATE TRIGGER transcription_check_append_only BEFORE UPDATE OR DELETE ON transcription_check
  FOR EACH ROW EXECUTE FUNCTION ocg_append_only();
--> statement-breakpoint
CREATE TRIGGER transcription_check_no_truncate BEFORE TRUNCATE ON transcription_check
  FOR EACH STATEMENT EXECUTE FUNCTION ocg_forbid_truncate();
