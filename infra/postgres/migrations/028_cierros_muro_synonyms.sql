-- Cierros "muro" synonyms (task 3c.21). Data-only migration.
--
-- Owner rule (Hormiglass): a customer who says "muro" or "muros" (for example
-- "un muro de 20 metros", "muro perimetral", "muro prefabricado") without
-- naming another product means Cierros de Hormigón. These phrases are appended
-- to cierros-hormigon's catalog_items.metadata.synonyms (migration 026 wrote
-- the rest of that list). A product whose name or synonyms hold a longer
-- "muro ..." phrase keeps it by longest match (productRefsMentionedV31).
--
-- Rules for this list (tests/unit/catalog-cierros-muro-synonyms-migration.test.js):
--   * every phrase maps only to cierros-hormigon (accent and case folded),
--     checked against the public 026 lists and, locally, the private data;
--   * no phrase equals a product name.
--
-- Idempotent: keyed by sku; only phrases not already in the list are appended
-- (in this order), every other metadata key and synonym is kept, and a row that
-- already holds all of them is not touched again.
--
-- Down migration: infra/postgres/rollback/028_cierros_muro_synonyms.down.sql
-- (kept outside migrations/ so reset-test-db.mjs never applies it forward).
UPDATE catalog_items AS ci
SET
  metadata = jsonb_set(
    COALESCE(ci.metadata, '{}'::jsonb),
    '{synonyms}',
    (CASE WHEN jsonb_typeof(ci.metadata->'synonyms') = 'array' THEN ci.metadata->'synonyms' ELSE '[]'::jsonb END)
      || COALESCE((
        SELECT jsonb_agg(to_jsonb(phrase.value) ORDER BY phrase.position)
        FROM jsonb_array_elements_text(data.synonyms) WITH ORDINALITY AS phrase(value, position)
        WHERE NOT (COALESCE(ci.metadata->'synonyms', '[]'::jsonb) @> jsonb_build_array(phrase.value))
      ), '[]'::jsonb),
    TRUE
  ),
  updated_at = NOW()
FROM (VALUES
  ('cierros-hormigon', '["muro", "muros", "muro perimetral", "muros perimetrales", "muro prefabricado", "muros prefabricados", "muro de cierre", "muro de hormigón"]'::jsonb)
) AS data(sku, synonyms)
WHERE ci.sku = data.sku
  AND NOT (COALESCE(ci.metadata->'synonyms', '[]'::jsonb) @> data.synonyms);
