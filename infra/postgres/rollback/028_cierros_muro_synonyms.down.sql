-- Down migration for 028_cierros_muro_synonyms.sql (task 3c.21). Removes
-- exactly the "muro" phrases 028 appended to cierros-hormigon's
-- metadata.synonyms; every other synonym (e.g. the 026 ones) and every other
-- metadata key is kept. If no synonym is left, the key is removed.
--
-- Kept outside infra/postgres/migrations/ on purpose: tests/scripts/reset-test-db.mjs
-- applies every numbered file in that directory, and this file must never run
-- as a forward migration. Apply it manually only when rolling back 028:
--   psql "$DATABASE_URL" -f infra/postgres/rollback/028_cierros_muro_synonyms.down.sql
UPDATE catalog_items AS ci
SET
  metadata = CASE
    WHEN kept.synonyms = '[]'::jsonb THEN ci.metadata - 'synonyms'
    ELSE jsonb_set(ci.metadata, '{synonyms}', kept.synonyms, TRUE)
  END,
  updated_at = NOW()
FROM (
  SELECT
    item.id,
    COALESCE((
      SELECT jsonb_agg(phrase.value ORDER BY phrase.position)
      FROM jsonb_array_elements(item.metadata->'synonyms') WITH ORDINALITY AS phrase(value, position)
      WHERE NOT ((phrase.value #>> '{}') = ANY (ARRAY[
        'muro', 'muros', 'muro perimetral', 'muros perimetrales', 'muro prefabricado',
        'muros prefabricados', 'muro de cierre', 'muro de hormigón'
      ]::text[]))
    ), '[]'::jsonb) AS synonyms
  FROM catalog_items AS item
  WHERE item.sku = 'cierros-hormigon'
    AND jsonb_typeof(item.metadata->'synonyms') = 'array'
    AND item.metadata->'synonyms' ?| ARRAY[
      'muro', 'muros', 'muro perimetral', 'muros perimetrales', 'muro prefabricado',
      'muros prefabricados', 'muro de cierre', 'muro de hormigón'
    ]::text[]
) AS kept
WHERE ci.id = kept.id;
