
WITH cats AS (
  SELECT id, code FROM catalog_categories
),
new_items AS (
  SELECT
    cats.id AS category_id,
    data.sku,
    data.name,
    data.item_type,
    data.short_description,
    data.keywords,
    data.cities,
    data.restrictions,
    data.perma_url
  FROM (VALUES
    ('cierros-hormigon', 'Cierros de Hormigón', 'product',
     'Cierros de hormigón para cierres perimetrales. Múltiples variantes y alturas disponibles.',
     ARRAY['cierro', 'hormigon', 'perimetral', 'cerca', 'pandereta', 'medianero'],
     ARRAY['Santiago', 'Valparaiso', 'Vina del Mar', 'Concepcion', 'Rancagua'],
     '{"requires_measurements": true, "requires_stock_validation": true, "has_variants": true}'::jsonb,
     'https://www.hormiglass.cl/producto/cierros-de-hormigon/'),

    ('durmientes-hormigon', 'Durmientes de Hormigón', 'product',
     'Durmientes de hormigón para pisos y jardines. Desde $8.300 hasta $9.100.',
     ARRAY['durmiente', 'hormigon', 'piso', 'jardin', 'borde', 'separador'],
     ARRAY['Santiago', 'Valparaiso', 'Vina del Mar', 'Concepcion', 'Rancagua'],
     '{"requires_measurements": true, "requires_stock_validation": true, "has_variants": true}'::jsonb,
     'https://www.hormiglass.cl/producto/durmientes-de-hormigon/'),

    ('placa-imitacion-piedra-laja', 'Placa Imitación Piedra Laja', 'product',
     'Placa de hormigón imitación piedra laja para cierres perimetrales. Precio $29.500.',
     ARRAY['placa', 'imitacion', 'piedra', 'laja', 'cierro', 'perimetral', 'decorativo'],
     ARRAY['Santiago', 'Valparaiso', 'Vina del Mar', 'Concepcion', 'Rancagua'],
     '{"requires_measurements": true, "requires_stock_validation": true}'::jsonb,
     'https://www.hormiglass.cl/producto/placa-imitacion-piedra-laja/'),

    ('maceteros-hormigon', 'Maceteros de Hormigón', 'product',
     'Maceteros de hormigón para jardín y decoración exterior. Desde $12.500 hasta $116.250 según tamaño y modelo.',
     ARRAY['macetero', 'maceta', 'jardin', 'decoracion', 'exterior', 'hormigon', 'ornamental'],
     ARRAY['Santiago', 'Valparaiso', 'Vina del Mar', 'Concepcion', 'Rancagua'],
     '{"requires_measurements": true, "requires_stock_validation": true, "has_variants": true}'::jsonb,
     'https://www.hormiglass.cl/producto/maceteros-de-hormigon/')
  ) AS data(sku, name, item_type, short_description, keywords, cities, restrictions, perma_url)
  JOIN cats ON cats.code = (
    CASE
      WHEN data.name IN ('Cierros de Hormigón', 'Placa Imitación Piedra Laja') THEN 'cierres-perimetrales'
      WHEN data.name = 'Durmientes de Hormigón' THEN 'pisos'
      WHEN data.name = 'Maceteros de Hormigón' THEN 'prefabricados'
    END
  )
)
INSERT INTO catalog_items (category_id, sku, name, item_type, short_description, service_keywords, applicable_cities, restrictions, metadata)
SELECT
  category_id, sku, name, item_type, short_description,
  keywords, cities, restrictions,
  jsonb_build_object('url', perma_url)
FROM new_items
ON CONFLICT (sku) DO UPDATE
SET
  category_id = EXCLUDED.category_id,
  name = EXCLUDED.name,
  item_type = EXCLUDED.item_type,
  short_description = EXCLUDED.short_description,
  service_keywords = EXCLUDED.service_keywords,
  applicable_cities = EXCLUDED.applicable_cities,
  restrictions = EXCLUDED.restrictions,
  metadata = EXCLUDED.metadata,
  updated_at = NOW();

UPDATE catalog_items
SET
  name = 'Maceteros de Hormigón',
  category_id = (SELECT id FROM catalog_categories WHERE code = 'prefabricados'),
  short_description = 'Maceteros de hormigón para jardín y decoración exterior. Desde $12.500 hasta $116.250 según tamaño y modelo.',
  service_keywords = ARRAY['macetero', 'maceta', 'jardin', 'decoracion', 'exterior', 'hormigon', 'ornamental'],
  restrictions = '{"requires_measurements": true, "requires_stock_validation": true, "has_variants": true}'::jsonb,
  metadata = metadata || '{"url": "https://www.hormiglass.cl/producto/maceteros-de-hormigon/"}'::jsonb,
  updated_at = NOW()
WHERE sku = 'maceteros';

UPDATE catalog_items
SET
  short_description = 'Maceteros de hormigón para jardín y decoración exterior. Desde $12.500 hasta $116.250 según tamaño y modelo.',
  service_keywords = ARRAY['macetero', 'maceta', 'jardin', 'decoracion', 'exterior', 'hormigon', 'ornamental'],
  restrictions = '{"requires_measurements": true, "requires_stock_validation": true, "has_variants": true}'::jsonb,
  metadata = metadata || '{"url": "https://www.hormiglass.cl/producto/maceteros-de-hormigon/"}'::jsonb,
  updated_at = NOW()
WHERE sku = 'maceteros-hormigon';

WITH items AS (
  SELECT ci.id, ci.sku, ci.name FROM catalog_items ci
)
INSERT INTO price_rules (
  catalog_item_id, code, price_type, currency,
  amount, amount_min, amount_max, unit, conditions, is_reference
)
SELECT
  items.id,
  items.sku || '-' || CASE
    WHEN data.precio_fijo IS NOT NULL THEN 'fixed'
    WHEN data.precio_min IS NOT NULL AND data.precio_max IS NOT NULL THEN 'range'
    ELSE 'requires_human'
  END,
  CASE
    WHEN data.precio_fijo IS NOT NULL THEN 'fixed'
    WHEN data.precio_min IS NOT NULL AND data.precio_max IS NOT NULL THEN 'range'
    ELSE 'requires_human'
  END,
  'CLP',
  data.precio_fijo,
  data.precio_min,
  data.precio_max,
  'unidad',
  CASE WHEN data.precio_fijo IS NULL AND data.precio_min IS NULL
    THEN '{"requires_quote": true}'::jsonb
    ELSE '{"requires_measurements": true}'::jsonb
  END,
  CASE WHEN data.precio_fijo IS NOT NULL THEN false ELSE true END
FROM (VALUES
  ('cierros-hormigon', NULL, 10500::numeric, 29500::numeric, NULL),
  ('durmientes-hormigon', NULL, 8300::numeric, 9100::numeric, NULL),
  ('placa-imitacion-piedra-laja', 29500::numeric, NULL, NULL, NULL),
  ('maceteros-hormigon', NULL, 12500::numeric, 116250::numeric, NULL),
  ('maceteros', NULL, 12500::numeric, 116250::numeric, NULL)
) AS data(sku, precio_fijo, precio_min, precio_max, precio_unit)
JOIN items ON items.sku = data.sku
ON CONFLICT (code) DO UPDATE
SET
  price_type = EXCLUDED.price_type,
  amount = EXCLUDED.amount,
  amount_min = EXCLUDED.amount_min,
  amount_max = EXCLUDED.amount_max,
  unit = EXCLUDED.unit,
  conditions = EXCLUDED.conditions,
  is_reference = EXCLUDED.is_reference,
  updated_at = NOW();

DELETE FROM price_rules
WHERE catalog_item_id IN (SELECT id FROM catalog_items WHERE sku = 'maceteros')
  AND code = 'maceteros-requires-human'
  AND price_type = 'requires_human';
