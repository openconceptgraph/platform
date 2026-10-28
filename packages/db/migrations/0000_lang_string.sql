-- A language map: { "en": "...", "af": "..." }, keyed by BCP 47 tag, every value
-- non-empty text. Used by check constraints, so it exists before the tables do.
-- Strict: a null column passes, as nullable columns should.
CREATE FUNCTION ocg_is_lang_string(value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE AS $$
BEGIN
  IF jsonb_typeof(value) <> 'object' OR value = '{}'::jsonb THEN
    RETURN false;
  END IF;
  RETURN NOT EXISTS (
    SELECT 1 FROM jsonb_each(value) AS e(tag, text)
    WHERE e.tag !~ '^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$'
       OR jsonb_typeof(e.text) <> 'string'
       OR btrim(e.text #>> '{}') = ''
  );
END $$;
