-- Down migration for 029_baldosa_minvu_synonyms.sql (task 3c.27). Removes the
-- tactile phrases 029 appended to baldosa-minvu's metadata.synonyms and appends
-- back the generic phrases 029 removed, in their 026 order, so the live row
-- returns to exactly ["baldosas minvu", "baldosa", "baldosas", "baldosa de vereda"].
-- Every other synonym and metadata key is kept; a second run touches no row.
--
-- Roll back the private delta step that created "Baldosas" FIRST (it owns
-- "baldosa" and "baldosa de vereda" while it exists), then this file.
--
-- Kept outside infra/postgres/migrations/ on purpose: tests/scripts/reset-test-db.mjs
-- applies every numbered file in that directory, and this file must never run
-- as a forward migration. Apply it manually only when rolling back 029:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f infra/postgres/rollback/029_baldosa_minvu_synonyms.down.sql
UPDATE catalog_items AS ci
SET
  metadata = jsonb_set(
    COALESCE(ci.metadata, '{}'::jsonb),
    '{synonyms}',
    COALESCE((
      SELECT jsonb_agg(phrase.value ORDER BY phrase.position)
      FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(ci.metadata->'synonyms') = 'array' THEN ci.metadata->'synonyms' ELSE '[]'::jsonb END
      ) WITH ORDINALITY AS phrase(value, position)
      WHERE NOT (data.removed @> jsonb_build_array(phrase.value))
    ), '[]'::jsonb)
      || COALESCE((
        SELECT jsonb_agg(to_jsonb(phrase.value) ORDER BY phrase.position)
        FROM jsonb_array_elements_text(data.added) WITH ORDINALITY AS phrase(value, position)
        WHERE NOT (COALESCE(ci.metadata->'synonyms', '[]'::jsonb) @> jsonb_build_array(phrase.value))
      ), '[]'::jsonb),
    TRUE
  ),
  updated_at = NOW()
FROM (VALUES
  ('baldosa-minvu', '["baldosa minvu táctil", "baldosa táctil", "baldosas táctiles", "baldosa podotáctil", "baldosas podotáctiles"]'::jsonb, '["baldosa", "baldosas", "baldosa de vereda"]'::jsonb)
) AS data(sku, removed, added)
WHERE ci.sku = data.sku
  AND (
    COALESCE(ci.metadata->'synonyms', '[]'::jsonb) ?| ARRAY(SELECT jsonb_array_elements_text(data.removed))
    OR NOT (COALESCE(ci.metadata->'synonyms', '[]'::jsonb) @> data.added)
  );
