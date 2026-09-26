-- Down migration for 025_item_aware_v3_state_mutations.sql (D8). Restores the
-- exact `apply_v3_state_mutations` body from
-- infra/postgres/migrations/022_restore_conversation_turn_executions.sql.
--
-- Kept outside infra/postgres/migrations/ on purpose: tests/scripts/reset-test-db.mjs
-- applies every numbered file in that directory, and this file must never run
-- as a forward migration. Apply it manually only when rolling back 025:
--   psql "$DATABASE_URL" -f infra/postgres/rollback/025_item_aware_v3_state_mutations.down.sql
--
-- No column or table is dropped: rows written with `line_items` keep their
-- flat projection, so this restored function still reads them correctly
-- (D3 reconciles again on the next forward upgrade).
CREATE OR REPLACE FUNCTION apply_v3_state_mutations(
  p_snapshot JSONB,
  p_mutations JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_result JSONB := COALESCE(p_snapshot, '{}'::JSONB);
  v_mutation JSONB;
  v_field TEXT;
BEGIN
  IF jsonb_typeof(COALESCE(p_mutations, '[]'::JSONB)) <> 'array' THEN
    RAISE EXCEPTION 'v3 mutations must be an array';
  END IF;

  FOR v_mutation IN SELECT value FROM jsonb_array_elements(COALESCE(p_mutations, '[]'::JSONB))
  LOOP
    v_field := NULLIF(v_mutation->>'field', '');
    IF v_field IS NULL OR v_field LIKE '\_%' ESCAPE '\' THEN
      RAISE EXCEPTION 'invalid v3 mutation field';
    END IF;
    IF v_mutation->>'operation' IN ('set', 'replace')
       AND v_mutation ? 'projected_value' THEN
      v_result := jsonb_set(v_result, ARRAY[v_field], v_mutation->'projected_value', TRUE);
    ELSE
      RAISE EXCEPTION 'unsupported v3 mutation operation';
    END IF;
  END LOOP;
  RETURN v_result;
END;
$$;
