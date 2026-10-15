-- Catalog product synonyms (task 3c.19). Data-only migration.
--
-- Live 2026-09-29 (v3.1): the customer wrote "Bloques de cemento", the model
-- only knew the catalog name "Bloques de Hormigón", asked whether that was
-- what they meant and then said it could not confirm it was the same thing.
-- Each active product now carries catalog_items.metadata.synonyms, a JSON
-- array of alternative names that point unambiguously to that one product.
-- `Load Conversation State` forwards them into the v3.1 grounding, where the
-- model and the validator treat a listed synonym as naming that product.
--
-- Rules for this list (tests/unit/catalog-product-synonyms-migration.test.js):
--   * a synonym maps to exactly one product (accent and case folded);
--   * a synonym never equals a product name nor appears inside another
--     product's name;
--   * terms shared by several products (pandereta, placa, poste, alambre,
--     bloque, cierre...) are never synonyms: they keep the clarification flow;
--   * overlapping phrases ("placa de 50" / "placa de 50 reforzada") resolve
--     by longest match.
--
-- Idempotent: keyed by sku, only the `synonyms` key of metadata is written
-- (every other metadata key, e.g. `url`, is kept), and a row that already
-- holds the same list is not touched again.
--
-- Down migration: infra/postgres/rollback/026_catalog_product_synonyms.down.sql
-- (kept outside migrations/ so reset-test-db.mjs never applies it forward).
UPDATE catalog_items AS ci
SET
  metadata = jsonb_set(COALESCE(ci.metadata, '{}'::jsonb), '{synonyms}', data.synonyms, TRUE),
  updated_at = NOW()
FROM (VALUES
  ('adocreto', '["adocretos"]'::jsonb),
  ('adoquin', '["adoquines", "adoquín de hormigón", "adoquín de cemento", "adoquín de concreto"]'::jsonb),
  ('alambre-concertina', '["concertina", "alambre de concertina", "concertina de seguridad"]'::jsonb),
  ('alambre-puas', '["alambre de púa", "alambre púa", "púas"]'::jsonb),
  ('baldosa-minvu', '["baldosas minvu", "baldosa", "baldosas", "baldosa de vereda"]'::jsonb),
  ('basas-para-pilar', '["basa", "basas", "basa de pilar", "basa para pilar", "base para pilar"]'::jsonb),
  ('bloques-hormigon', '["bloque de hormigón", "bloque de cemento", "bloques de cemento", "bloque de concreto", "bloques de concreto"]'::jsonb),
  ('bordes-piscina', '["borde de piscina", "bordes de pileta", "borde de pileta"]'::jsonb),
  ('cemento', '["saco de cemento", "sacos de cemento", "bolsa de cemento", "bolsas de cemento"]'::jsonb),
  ('cierros-hormigon', '["cierro de hormigón", "cierros de concreto", "cierro de concreto", "cierre de hormigón", "cierro prefabricado"]'::jsonb),
  ('durmientes-hormigon', '["durmiente", "durmientes", "durmiente de hormigón", "durmiente de concreto"]'::jsonb),
  ('maceteros-hormigon', '["macetero", "maceteros", "macetero de hormigón", "macetero de cemento", "maceta de hormigón"]'::jsonb),
  ('pastelones', '["pastelón", "pastelón de hormigón", "pastelón de cemento", "pastelones de cemento"]'::jsonb),
  ('pigmentos', '["pigmento", "pigmento para hormigón", "colorante para hormigón"]'::jsonb),
  ('placa-imitacion-piedra-laja', '["placa laja", "placa piedra laja", "placa imitación laja"]'::jsonb),
  ('placas-imitacion-madera', '["placa imitación madera", "placa madera", "pandereta imitación madera"]'::jsonb),
  ('placas-50-cm', '["placa de 50", "placas de 50", "placa 50"]'::jsonb),
  ('placas-50-cm-reforzadas', '["placa reforzada", "placas reforzadas", "placa de 50 reforzada", "placas de 50 reforzadas", "placa de 50 cm reforzada", "placa 50 reforzada"]'::jsonb),
  ('placas-60-cm', '["placa de 60", "placas de 60", "placa 60"]'::jsonb),
  ('placas-hormigon', '["placa de hormigón", "placa de concreto", "placa de cemento"]'::jsonb),
  ('postes-curvos', '["poste curvo", "postes curvos de hormigón"]'::jsonb),
  ('postes-rectos', '["poste recto", "postes rectos de hormigón"]'::jsonb),
  ('soleras-solerillas', '["solera", "soleras", "solerilla", "solerillas"]'::jsonb),
  ('tapas-camara', '["tapa de cámara", "tapa de alcantarillado", "tapa de registro"]'::jsonb)
) AS data(sku, synonyms)
WHERE ci.sku = data.sku
  AND ci.metadata->'synonyms' IS DISTINCT FROM data.synonyms;
