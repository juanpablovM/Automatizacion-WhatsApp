-- Baldosa Minvu synonyms after the baldosa split (task 3c.27). Data-only migration.
--
-- Owner decision (Hormiglass): "Baldosa Minvu" (sku baldosa-minvu, name and sku
-- unchanged so old leads and ClickUp tasks keep working) is only the tactile
-- MINVU tiles. Every other tile is the product "Baldosas" (sku baldosas),
-- created by the private catalog data step (db/seeds/private/, gitignored).
-- So the generic phrases "baldosa", "baldosas" and "baldosa de vereda" leave
-- baldosa-minvu's catalog_items.metadata.synonyms (026 wrote them there):
-- "Baldosas" is the new product's name and the other two are its synonyms.
-- The tactile phrases are appended after the kept ones ("baldosas minvu").
-- Longest match (productRefsMentionedV31) keeps "baldosa minvu" /
-- "baldosas minvu" / "baldosa táctil" on Baldosa Minvu and "baldosa lisa" on
-- Baldosas.
--
-- Rules for this list (tests/unit/catalog-baldosa-minvu-synonyms-migration.test.js):
--   * every added phrase maps only to baldosa-minvu (accent and case folded),
--     checked against the public 026/028 lists and, locally, the private data;
--   * no phrase equals a product name.
--
-- Idempotent: keyed by sku; only the listed phrases are removed (exact text),
-- only missing ones are appended (in this order), every other metadata key and
-- synonym is kept, and a row that holds no removed phrase and every added one
-- is not touched again.
--
-- Deploy order: apply this file BEFORE the private delta step that creates
-- "Baldosas" (it claims "baldosa" and "baldosa de vereda"). Without that private
-- step a database has no product for the bare word "baldosa".
--
-- Down migration: infra/postgres/rollback/029_baldosa_minvu_synonyms.down.sql
-- (kept outside migrations/ so reset-test-db.mjs never applies it forward).
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
  ('baldosa-minvu', '["baldosa", "baldosas", "baldosa de vereda"]'::jsonb, '["baldosa minvu táctil", "baldosa táctil", "baldosas táctiles", "baldosa podotáctil", "baldosas podotáctiles"]'::jsonb)
) AS data(sku, removed, added)
WHERE ci.sku = data.sku
  AND (
    COALESCE(ci.metadata->'synonyms', '[]'::jsonb) ?| ARRAY(SELECT jsonb_array_elements_text(data.removed))
    OR NOT (COALESCE(ci.metadata->'synonyms', '[]'::jsonb) @> data.added)
  );
