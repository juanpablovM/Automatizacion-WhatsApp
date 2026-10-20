-- Down migration for 026_catalog_product_synonyms.sql (task 3c.19). Removes
-- only the `synonyms` key that 026 wrote; every other metadata key (e.g.
-- `url`) is kept.
--
-- Kept outside infra/postgres/migrations/ on purpose: tests/scripts/reset-test-db.mjs
-- applies every numbered file in that directory, and this file must never run
-- as a forward migration. Apply it manually only when rolling back 026:
--   psql "$DATABASE_URL" -f infra/postgres/rollback/026_catalog_product_synonyms.down.sql
--
-- Without synonyms the load query simply omits the field, so the v3.1
-- grounding goes back to names only (the pre-026 behavior).
UPDATE catalog_items
SET
  metadata = metadata - 'synonyms',
  updated_at = NOW()
WHERE metadata ? 'synonyms'
  AND sku IN (
    'adocreto', 'adoquin', 'alambre-concertina', 'alambre-puas', 'baldosa-minvu',
    'basas-para-pilar', 'bloques-hormigon', 'bordes-piscina', 'cemento', 'cierros-hormigon',
    'durmientes-hormigon', 'maceteros-hormigon', 'pastelones', 'pigmentos',
    'placa-imitacion-piedra-laja', 'placas-imitacion-madera', 'placas-50-cm',
    'placas-50-cm-reforzadas', 'placas-60-cm', 'placas-hormigon', 'postes-curvos',
    'postes-rectos', 'soleras-solerillas', 'tapas-camara'
  );
