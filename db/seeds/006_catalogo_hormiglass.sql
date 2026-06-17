

INSERT INTO catalog_categories (code, name, description, sort_order)
VALUES
  ('pisos', 'Pisos', 'Productos para pisos: baldosas, adoquines, pastelones, adocreto, tapas de cámara', 10),
  ('construccion', 'Construcción', 'Materiales de construcción como cemento', 20),
  ('piscina', 'Piscina', 'Bordes de piscina y accesorios', 30),
  ('aridos', 'Áridos', 'Pigmentos y áridos para hormigón', 40),
  ('cierres-perimetrales', 'Cierres Perimetrales', 'Placas, postes, alambres para cierres y cerramientos', 50),
  ('prefabricados', 'Prefabricados de Hormigón', 'Basas para pilar y otros prefabricados', 60),
  ('maceteros', 'Maceteros', 'Maceteros de hormigón', 70),
  ('servicios', 'Servicios', 'Servicios de instalación, transporte y movimiento de tierra', 80)
ON CONFLICT (code) DO UPDATE
SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  sort_order = EXCLUDED.sort_order,
  updated_at = NOW();

WITH cats AS (
  SELECT id, code FROM catalog_categories
),
items_data AS (
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
    ('adocreto', 'Adocreto', 'product',
     'Adocreto para pisos. Múltiples variantes y medidas disponibles. Ideal para áreas peatonales y vehiculares.',
     ARRAY['adocreto', 'piso', 'adoquin', 'jardin', 'exterior'],
     ARRAY['Santiago', 'Valparaiso', 'Vina del Mar', 'Concepcion', 'Rancagua'],
     '{"requires_measurements": true, "requires_stock_validation": true, "has_variants": true}'::jsonb,
     'https://www.hormiglass.cl/producto/adocreto/'),

    ('adoquin', 'Adoquín', 'product',
     'Adoquín de hormigón para pavimentos. Precio $1.300.',
     ARRAY['adoquin', 'pavimento', 'piso', 'exterior', 'calle'],
     ARRAY['Santiago', 'Valparaiso', 'Vina del Mar', 'Concepcion'],
     '{"requires_measurements": true, "requires_stock_validation": true}'::jsonb,
     'https://www.hormiglass.cl/producto/adoquin/'),

    ('bloques-hormigon', 'Bloques de Hormigón', 'product',
     'Bloques de hormigón para construcción. Múltiples variantes desde $1.319.',
     ARRAY['bloque', 'hormigon', 'construccion', 'muro', 'pared'],
     ARRAY['Santiago', 'Valparaiso', 'Vina del Mar', 'Concepcion', 'Rancagua'],
     '{"requires_measurements": true, "requires_stock_validation": true, "has_variants": true}'::jsonb,
     'https://www.hormiglass.cl/producto/bloques-de-hormigon/'),

    ('soleras-solerillas', 'Soleras y Solerillas', 'product',
     'Soleras y solerillas de hormigón. Desde $2.276 hasta $8.812 según variante.',
     ARRAY['solera', 'solerilla', 'piso', 'borde', 'jardin', 'exterior'],
     ARRAY['Santiago', 'Valparaiso', 'Vina del Mar', 'Concepcion'],
     '{"requires_measurements": true, "requires_stock_validation": true, "has_variants": true}'::jsonb,
     'https://www.hormiglass.cl/producto/soleras-y-solerillas/'),

    ('pastelones', 'Pastelones', 'product',
     'Pastelones de hormigón para pisos. Desde $3.870 hasta $4.350.',
     ARRAY['pastelon', 'pasto', 'jardin', 'piso', 'exterior'],
     ARRAY['Santiago', 'Valparaiso', 'Vina del Mar', 'Concepcion'],
     '{"requires_measurements": true, "requires_stock_validation": true, "has_variants": true}'::jsonb,
     'https://www.hormiglass.cl/producto/pastelones/'),

    ('baldosa-minvu', 'Baldosa Minvu', 'product',
     'Baldosa MINVU para pisos. Desde $3.887 hasta $5.819. Certificada.',
     ARRAY['baldosa', 'minvu', 'piso', 'vereda', 'acera', 'peatonal'],
     ARRAY['Santiago', 'Valparaiso', 'Vina del Mar', 'Concepcion', 'Rancagua'],
     '{"requires_measurements": true, "requires_stock_validation": true, "certification": "MINVU", "has_variants": true}'::jsonb,
     'https://www.hormiglass.cl/producto/baldosa-minvu/'),

    ('cemento', 'Cemento', 'product',
     'Cemento para construcción. Desde $4.463 hasta $5.233.',
     ARRAY['cemento', 'construccion', 'material'],
     ARRAY['Santiago', 'Valparaiso', 'Vina del Mar', 'Concepcion', 'Rancagua'],
     '{"requires_stock_validation": true, "has_variants": true}'::jsonb,
     'https://www.hormiglass.cl/producto/cemento/'),

    ('bordes-piscina', 'Bordes de Piscina', 'product',
     'Bordes de piscina de hormigón. Desde $5.000 hasta $9.286.',
     ARRAY['borde', 'piscina', 'pileta', 'piscinero'],
     ARRAY['Santiago', 'Valparaiso', 'Vina del Mar', 'Concepcion'],
     '{"requires_measurements": true, "requires_stock_validation": true, "has_variants": true}'::jsonb,
     'https://www.hormiglass.cl/producto/bordes-de-piscina/'),

    ('pigmentos', 'Pigmentos', 'product',
     'Pigmentos para hormigón. Desde $5.400 hasta $17.980.',
     ARRAY['pigmento', 'color', 'hormigon', 'tinte', 'arido'],
     ARRAY['Santiago', 'Valparaiso', 'Vina del Mar'],
     '{"requires_stock_validation": true, "has_variants": true}'::jsonb,
     'https://www.hormiglass.cl/producto/pigmentos/'),

    ('adocesped', 'Adocesped', 'product',
     'Adocesped para estacionamientos y áreas verdes. Precio $14.626.',
     ARRAY['adocesped', 'cesped', 'estacionamiento', 'piso', 'jardin', 'ecologico'],
     ARRAY['Santiago', 'Valparaiso', 'Vina del Mar', 'Concepcion', 'Rancagua'],
     '{"requires_measurements": true, "requires_stock_validation": true}'::jsonb,
     'https://www.hormiglass.cl/producto/adocesped/'),

    ('placas-imitacion-madera', 'Placas Imitación Madera', 'product',
     'Placas de hormigón imitación madera para cierres perimetrales. Precio $10.500.',
     ARRAY['placa', 'madera', 'imitacion', 'cierro', 'perimetral', 'cerca', 'pandereta'],
     ARRAY['Santiago', 'Valparaiso', 'Vina del Mar', 'Concepcion', 'Rancagua'],
     '{"requires_measurements": true, "requires_stock_validation": true, "has_variants": true}'::jsonb,
     'https://www.hormiglass.cl/producto/placas-imitacion-madera/'),

    ('placas-50-cm', 'Placas de 50 cm', 'product',
     'Placas de hormigón de 50 cm para cierres perimetrales. Desde $14.900 hasta $19.800.',
     ARRAY['placa', '50cm', 'cierro', 'perimetral', 'cerca', 'pandereta'],
     ARRAY['Santiago', 'Valparaiso', 'Vina del Mar', 'Concepcion', 'Rancagua'],
     '{"requires_measurements": true, "requires_stock_validation": true, "height_cm": 50, "has_variants": true}'::jsonb,
     'https://www.hormiglass.cl/producto/placas-de-50-cm/'),

    ('placas-hormigon', 'Placas de Hormigón', 'product',
     'Placas de hormigón para cierres perimetrales. Grupo con múltiples variantes desde $14.900.',
     ARRAY['placa', 'hormigon', 'cierro', 'perimetral', 'cerca', 'pandereta'],
     ARRAY['Santiago', 'Valparaiso', 'Vina del Mar', 'Concepcion', 'Rancagua'],
     '{"requires_measurements": true, "requires_stock_validation": true, "is_group": true, "has_variants": true}'::jsonb,
     'https://www.hormiglass.cl/producto/placas-de-hormigon/'),

    ('postes-rectos', 'Postes Rectos', 'product',
     'Postes rectos de hormigón para cierres perimetrales. Desde $15.000 hasta $29.500.',
     ARRAY['poste', 'recto', 'cierro', 'perimetral', 'cerca', 'pilar'],
     ARRAY['Santiago', 'Valparaiso', 'Vina del Mar', 'Concepcion', 'Rancagua'],
     '{"requires_measurements": true, "requires_stock_validation": true, "has_variants": true}'::jsonb,
     'https://www.hormiglass.cl/producto/postes-rectos/'),

    ('placas-60-cm', 'Placas de 60 cm', 'product',
     'Placas de hormigón de 60 cm para cierres perimetrales. Precio $19.800.',
     ARRAY['placa', '60cm', 'cierro', 'perimetral', 'cerca', 'pandereta'],
     ARRAY['Santiago', 'Valparaiso', 'Vina del Mar', 'Concepcion', 'Rancagua'],
     '{"requires_measurements": true, "requires_stock_validation": true, "height_cm": 60}'::jsonb,
     'https://www.hormiglass.cl/producto/placas-de-60-cm/'),

    ('basas-para-pilar', 'Basas Para Pilar', 'product',
     'Basas para pilar de hormigón prefabricado. Desde $9.900 hasta $24.000.',
     ARRAY['basa', 'pilar', 'prefabricado', 'piso', 'base'],
     ARRAY['Santiago', 'Valparaiso', 'Vina del Mar', 'Concepcion', 'Rancagua'],
     '{"requires_measurements": true, "requires_stock_validation": true, "has_variants": true}'::jsonb,
     'https://www.hormiglass.cl/producto/basas-para-pilar/'),

    ('placas-50-cm-reforzadas', 'Placas de 50 cm Reforzadas', 'product',
     'Placas de hormigón reforzadas de 50 cm. Desde $27.000 hasta $34.300.',
     ARRAY['placa', '50cm', 'reforzada', 'cierro', 'perimetral', 'cerca', 'pandereta'],
     ARRAY['Santiago', 'Valparaiso', 'Vina del Mar', 'Concepcion', 'Rancagua'],
     '{"requires_measurements": true, "requires_stock_validation": true, "height_cm": 50, "reinforced": true}'::jsonb,
     'https://www.hormiglass.cl/producto/placas-de-50-cm-reforzadas/'),

    ('postes-curvos', 'Postes Curvos', 'product',
     'Postes curvos de hormigón para cierres perimetrales. Desde $22.500 hasta $46.000.',
     ARRAY['poste', 'curvo', 'cierro', 'perimetral', 'cerca', 'pilar'],
     ARRAY['Santiago', 'Valparaiso', 'Vina del Mar', 'Concepcion', 'Rancagua'],
     '{"requires_measurements": true, "requires_stock_validation": true, "has_variants": true}'::jsonb,
     'https://www.hormiglass.cl/producto/postes-curvos/'),

    ('tapas-camara', 'Tapas de Cámara', 'product',
     'Tapas de cámara de hormigón. Desde $13.300 hasta $44.700.',
     ARRAY['tapa', 'camara', 'piso', 'tapa', 'registro', 'alcantarilla'],
     ARRAY['Santiago', 'Valparaiso', 'Vina del Mar', 'Concepcion', 'Rancagua'],
     '{"requires_measurements": true, "requires_stock_validation": true, "has_variants": true}'::jsonb,
     'https://www.hormiglass.cl/producto/tapas-de-camara/'),

    ('alambre-puas', 'Alambre de Púas', 'product',
     'Alambre de púas para cierres perimetrales. Precio bajo cotización.',
     ARRAY['alambre', 'puas', 'cierro', 'perimetral', 'cerca', 'seguridad'],
     ARRAY['Santiago', 'Valparaiso', 'Vina del Mar', 'Concepcion', 'Rancagua'],
     '{"requires_quote": true, "no_public_price": true}'::jsonb,
     'https://www.hormiglass.cl/producto/alamabre-puas/'),

    ('alambre-concertina', 'Alambre Concertina', 'product',
     'Alambre concertina para cierres perimetrales de seguridad. Precio bajo cotización.',
     ARRAY['alambre', 'concertina', 'cierro', 'perimetral', 'cerca', 'seguridad'],
     ARRAY['Santiago', 'Valparaiso', 'Vina del Mar', 'Concepcion', 'Rancagua'],
     '{"requires_quote": true, "no_public_price": true}'::jsonb,
     'https://www.hormiglass.cl/producto/alambre-concertina/'),

    ('maceteros', 'Maceteros', 'product',
     'Maceteros de hormigón. Producto listado en cotizador. Precio no confirmado en catálogo público.',
     ARRAY['macetero', 'jardin', 'decoracion', 'exterior', 'maceta'],
     ARRAY['Santiago', 'Valparaiso', 'Vina del Mar'],
     '{"requires_quote": true, "no_public_price": true}'::jsonb,
     'https://www.hormiglass.cl/producto/maceteros/'),

    ('venta-productos', 'Venta de Productos', 'service',
     'Venta de productos Hormiglass. Precio bajo cotización según proyecto.',
     ARRAY['venta', 'cotizacion', 'product', 'presupuesto'],
     ARRAY['Santiago', 'Valparaiso', 'Vina del Mar', 'Concepcion', 'Rancagua', 'Temuco', 'La Serena', 'Antofagasta'],
     '{"requires_quote": true, "price_type": "quote"}'::jsonb,
     NULL),

    ('instalacion', 'Instalación', 'service',
     'Servicio de instalación de productos Hormiglass. Precio bajo cotización según proyecto.',
     ARRAY['instalacion', 'montaje', 'colocacion', 'mano de obra', 'service'],
     ARRAY['Santiago', 'Valparaiso', 'Vina del Mar', 'Concepcion', 'Rancagua'],
     '{"requires_quote": true, "price_type": "quote"}'::jsonb,
     NULL),

    ('transporte-carga', 'Transporte de Carga', 'service',
     'Servicio de transporte de carga para productos Hormiglass. Precio bajo cotización.',
     ARRAY['transporte', 'carga', 'despacho', 'envio', 'flete', 'entrega'],
     ARRAY['Santiago', 'Valparaiso', 'Vina del Mar', 'Concepcion', 'Rancagua'],
     '{"requires_quote": true, "price_type": "quote"}'::jsonb,
     NULL),

    ('movimiento-tierra', 'Movimiento de Tierra', 'service',
     'Servicio de movimiento de tierra para preparación de terreno. Precio bajo cotización.',
     ARRAY['movimiento', 'tierra', 'excavacion', 'terreno', 'preparacion', 'nivelacion'],
     ARRAY['Santiago', 'Valparaiso', 'Vina del Mar', 'Concepcion', 'Rancagua'],
     '{"requires_quote": true, "price_type": "quote"}'::jsonb,
     NULL)
  ) AS data(sku, name, item_type, short_description, keywords, cities, restrictions, perma_url)
  JOIN cats ON cats.code = (
    CASE
      WHEN data.name IN ('Adocreto', 'Adoquín', 'Bloques de Hormigón', 'Soleras y Solerillas', 'Pastelones', 'Baldosa Minvu', 'Tapas de Cámara') THEN 'pisos'
      WHEN data.name = 'Cemento' THEN 'construccion'
      WHEN data.name = 'Bordes de Piscina' THEN 'piscina'
      WHEN data.name = 'Pigmentos' THEN 'aridos'
      WHEN data.name IN ('Placas Imitación Madera', 'Placas de 50 cm', 'Placas de Hormigón', 'Postes Rectos', 'Placas de 60 cm', 'Placas de 50 cm Reforzadas', 'Postes Curvos', 'Alambre de Púas', 'Alambre Concertina') THEN 'cierres-perimetrales'
      WHEN data.name = 'Basas Para Pilar' THEN 'prefabricados'
      WHEN data.name = 'Maceteros' THEN 'maceteros'
      WHEN data.name IN ('Venta de Productos', 'Instalación', 'Transporte de Carga', 'Movimiento de Tierra') THEN 'servicios'
    END
  )
)
INSERT INTO catalog_items (category_id, sku, name, item_type, short_description, service_keywords, applicable_cities, restrictions, metadata)
SELECT
  category_id,
  sku,
  name,
  item_type,
  short_description,
  keywords,
  cities,
  restrictions,
  jsonb_build_object('url', perma_url)
FROM items_data
ON CONFLICT (sku) DO UPDATE
SET
  name = EXCLUDED.name,
  item_type = EXCLUDED.item_type,
  short_description = EXCLUDED.short_description,
  service_keywords = EXCLUDED.service_keywords,
  applicable_cities = EXCLUDED.applicable_cities,
  restrictions = EXCLUDED.restrictions,
  metadata = EXCLUDED.metadata,
  updated_at = NOW();

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
  CASE
    WHEN items.name IN ('Cemento', 'Pigmentos') THEN 'unidad'
    WHEN items.name IN ('Bordes de Piscina', 'Basas Para Pilar', 'Tapas de Cámara', 'Maceteros') THEN 'unidad'
    WHEN items.name IN ('Placas Imitación Madera', 'Placas de 50 cm', 'Placas de Hormigón', 'Placas de 60 cm', 'Placas de 50 cm Reforzadas') THEN 'unidad'
    WHEN items.name IN ('Postes Rectos', 'Postes Curvos') THEN 'unidad'
    ELSE 'm2'
  END,
  CASE
    WHEN data.precio_fijo IS NULL AND data.precio_min IS NULL THEN '{"requires_quote": true}'::jsonb
    ELSE '{"requires_measurements": true}'::jsonb
  END,
  CASE WHEN data.precio_fijo IS NOT NULL THEN false ELSE true END
FROM (VALUES
  ('adocreto', NULL, 330::numeric, 920::numeric, NULL),
  ('adoquin', 1300::numeric, NULL, NULL, NULL),
  ('bloques-hormigon', NULL, 1319::numeric, 1910::numeric, NULL),
  ('soleras-solerillas', NULL, 2276::numeric, 8812::numeric, NULL),
  ('pastelones', NULL, 3870::numeric, 4350::numeric, NULL),
  ('baldosa-minvu', NULL, 3887::numeric, 5819::numeric, NULL),
  ('cemento', NULL, 4463::numeric, 5233::numeric, NULL),
  ('bordes-piscina', NULL, 5000::numeric, 9286::numeric, NULL),
  ('pigmentos', NULL, 5400::numeric, 17980::numeric, NULL),
  ('adocesped', 14626::numeric, NULL, NULL, NULL),
  ('placas-imitacion-madera', 10500::numeric, NULL, NULL, NULL),
  ('placas-50-cm', NULL, 14900::numeric, 19800::numeric, NULL),
  ('placas-hormigon', NULL, 14900::numeric, 27000::numeric, NULL),
  ('postes-rectos', NULL, 15000::numeric, 29500::numeric, NULL),
  ('placas-60-cm', 19800::numeric, NULL, NULL, NULL),
  ('basas-para-pilar', NULL, 9900::numeric, 24000::numeric, NULL),
  ('placas-50-cm-reforzadas', NULL, 27000::numeric, 34300::numeric, NULL),
  ('postes-curvos', NULL, 22500::numeric, 46000::numeric, NULL),
  ('tapas-camara', NULL, 13300::numeric, 44700::numeric, NULL)
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

INSERT INTO price_rules (
  catalog_item_id, code, price_type, currency, conditions, is_reference
)
SELECT
  items.id,
  items.sku || '-requires-human',
  'requires_human',
  'CLP',
  '{"requires_quote": true, "no_public_price": true}'::jsonb,
  true
FROM catalog_items items
WHERE items.sku IN ('alambre-puas', 'alambre-concertina', 'maceteros',
                     'venta-productos', 'instalacion', 'transporte-carga', 'movimiento-tierra')
ON CONFLICT (code) DO NOTHING;
