#!/usr/bin/env node
// Catalog technical sheets (task 3c.20): SQL generator for PRIVATE data.
//
// The real technical-sheet data is the owner's private material and is never
// committed (the GitHub repository is public). It lives only in the gitignored
// directory db/seeds/private/:
//   db/seeds/private/technical_sheets.json             <- input (private)
//   db/seeds/private/027_catalog_technical_sheets.sql  <- generated apply SQL (private)
//   db/seeds/private/027_catalog_technical_sheets.down.sql <- generated rollback (private)
// The generated SQL is deliberately NOT under infra/postgres/migrations/, so
// no fresh or test database ever applies it automatically.
//
// Usage (from the repository root):
//   node scripts/catalog/technical-sheets.mjs              # validate the data, write both SQL files
//   node scripts/catalog/technical-sheets.mjs --check      # fail if the SQL files are missing or stale
//   node scripts/catalog/technical-sheets.mjs --data <json> --out <apply.sql>   # other paths
//                                                         # (rollback goes next to it as .down.sql)
// Apply / roll back (manually, once, after a pre-check of the target rows):
//   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/seeds/private/027_catalog_technical_sheets.sql
//   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/seeds/private/027_catalog_technical_sheets.down.sql
//
// Data file shape: { items: [ item ] }, each item keyed by `sku`:
//   { sku, action: 'update', technical_sheet }                       existing row: only metadata.technical_sheet
//   { sku, action: 'reactivate', synonyms?, technical_sheet }        inactive row: activated (+ synonyms)
//   { sku, action: 'create', name, item_type, category_code, short_description,
//     service_keywords[], applicable_cities[], restrictions{}, synonyms?, technical_sheet }
// technical_sheet = { description, general_specs{}, variants[{ name, code, dimensions, weight,
//   yield, resistance, colors[], finishes[], other{} }], unconfirmed{ label: [values] }, source_files[] }
// Values stated in a sheet must be confirmed; conflicting or doubtful values go to `unconfirmed`,
// which the assistant never states. Prices are rejected: the assistant never quotes them.
//
// The generated SQL is idempotent and keyed by sku. Rows it creates or reactivates carry
// metadata.catalog_migration_027 ('created' | 'reactivated'), so the rollback restores the
// prior rows exactly (updated_at aside): it deletes created rows, deactivates reactivated rows
// (removing the synonyms it added) and removes only the technical_sheet key elsewhere.
//
// Delta steps (task 3c.27). The data file always holds the FINAL state, so the regenerated 027
// pair still builds (or removes) the whole catalog at once. A change to data that is already
// applied live ships as its own private step, declared in `deltas[]`:
//   { id: '030', name: 'baldosas_split', task, skus[], previous_technical_sheets{ sku: sheet } }
// For each delta the generator also writes db/seeds/private/<id>_catalog_<name>.sql (+ .down.sql).
// A delta touches only its skus (actions update or create; a sku belongs to one delta at most):
// it creates its new rows (metadata.catalog_migration_<id> = 'created') and rewrites the sheets
// that differ. Every updated sku records the sheet it had before, so the delta rollback deletes
// the rows it created and restores those sheets, only while the delta's sheet is still there.
// The 027 rollback also deletes rows a delta created. Apply after 027; roll back before 027:
//   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/seeds/private/030_catalog_baldosas_split.sql
//   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/seeds/private/030_catalog_baldosas_split.down.sql
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEFAULT_DATA_PATH = 'db/seeds/private/technical_sheets.json';
export const DEFAULT_APPLY_PATH = 'db/seeds/private/027_catalog_technical_sheets.sql';
export const MARKER = 'catalog_migration_027';
export const markerFor = (id) => `catalog_migration_${id}`;

const ACTIONS = new Set(['update', 'reactivate', 'create']);
const SHEET_KEYS = ['description', 'general_specs', 'source_files', 'unconfirmed', 'variants'];
const VARIANT_KEYS = ['code', 'colors', 'dimensions', 'finishes', 'name', 'other', 'resistance', 'weight', 'yield'];
const PRICE_KEY = /price|precio|valor|costo|cost|tarifa|clp|iva/i;
const PRICE_TEXT = /\$|\bclp\b|\bprecios?\b|\bprices?\b|\biva\b|\buf\b/i;

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isStringList = (value) => Array.isArray(value) && value.every((entry) => typeof entry === 'string' && entry.trim() === entry && entry !== '');

// Rejects any key or string that looks like a price, anywhere in the item.
const findPriceLike = (value, where) => {
  if (typeof value === 'string') return PRICE_TEXT.test(value) ? [`${where}: "${value}"`] : [];
  if (Array.isArray(value)) return value.flatMap((entry, index) => findPriceLike(entry, `${where}[${index}]`));
  if (isObject(value)) {
    return Object.entries(value).flatMap(([key, entry]) => [
      ...(PRICE_KEY.test(key) ? [`${where}.${key}`] : []),
      ...findPriceLike(entry, `${where}.${key}`),
    ]);
  }
  return [];
};

export const validateTechnicalSheetsData = (data) => {
  const errors = [];
  if (!isObject(data) || !Array.isArray(data.items) || data.items.length === 0) return ['data.items must be a non-empty array'];
  const skus = new Set();
  const synonymOwners = new Map();
  data.items.forEach((item, index) => {
    const where = `items[${index}]${item?.sku ? ` (${item.sku})` : ''}`;
    if (!isObject(item) || typeof item.sku !== 'string' || !/^[a-z0-9-]+$/.test(item.sku)) {
      errors.push(`${where}: sku must match [a-z0-9-]+`);
      return;
    }
    if (skus.has(item.sku)) errors.push(`${where}: duplicate sku`);
    skus.add(item.sku);
    if (!ACTIONS.has(item.action)) errors.push(`${where}: action must be update, reactivate or create`);
    if (item.action === 'update' && Object.keys(item).sort().join() !== 'action,sku,technical_sheet') {
      errors.push(`${where}: an update carries only sku, action and technical_sheet`);
    }
    if (item.action === 'create') {
      for (const key of ['name', 'category_code', 'short_description']) {
        if (typeof item[key] !== 'string' || item[key].trim() === '') errors.push(`${where}: ${key} is required`);
      }
      if (!['product', 'service'].includes(item.item_type)) errors.push(`${where}: item_type must be product or service`);
      if (!isStringList(item.service_keywords) || !isStringList(item.applicable_cities)) errors.push(`${where}: service_keywords and applicable_cities must be string lists`);
      if (!isObject(item.restrictions)) errors.push(`${where}: restrictions must be an object`);
    }
    if ('synonyms' in item) {
      if (!isStringList(item.synonyms) || item.synonyms.length === 0) errors.push(`${where}: synonyms must be a non-empty list of trimmed strings`);
      if (item.action === 'update') errors.push(`${where}: an update never changes synonyms`);
      for (const synonym of Array.isArray(item.synonyms) ? item.synonyms : []) {
        const key = String(synonym).normalize('NFD').replace(/[̀-ͯ]/g, '').toLocaleLowerCase('es');
        if (synonymOwners.has(key) && synonymOwners.get(key) !== item.sku) errors.push(`${where}: synonym "${synonym}" also belongs to ${synonymOwners.get(key)}`);
        synonymOwners.set(key, item.sku);
      }
    }
    const sheet = item.technical_sheet;
    if (!isObject(sheet) || Object.keys(sheet).sort().join() !== SHEET_KEYS.join()) {
      errors.push(`${where}: technical_sheet must have exactly ${SHEET_KEYS.join(', ')}`);
    } else {
      if (typeof sheet.description !== 'string' || sheet.description.trim() === '') errors.push(`${where}: description is required`);
      if (!isObject(sheet.general_specs) || !isObject(sheet.unconfirmed)) errors.push(`${where}: general_specs and unconfirmed must be objects`);
      if (!Array.isArray(sheet.variants) || sheet.variants.length === 0) errors.push(`${where}: variants must be a non-empty array`);
      for (const variant of Array.isArray(sheet.variants) ? sheet.variants : []) {
        if (!isObject(variant) || Object.keys(variant).sort().join() !== VARIANT_KEYS.join()) errors.push(`${where}: every variant has exactly ${VARIANT_KEYS.join(', ')}`);
        else if (typeof variant.name !== 'string' || variant.name.trim() === '') errors.push(`${where}: variant name is required`);
      }
      for (const [label, values] of Object.entries(isObject(sheet.unconfirmed) ? sheet.unconfirmed : {})) {
        if (!isStringList(values) || values.length === 0) errors.push(`${where}: unconfirmed "${label}" must list its values`);
      }
      if (!isStringList(sheet.source_files) || sheet.source_files.some((file) => file.includes('/'))) errors.push(`${where}: source_files must be plain file names`);
    }
    for (const found of findPriceLike(item, where)) errors.push(`price-like data is not allowed: ${found}`);
  });
  errors.push(...validateDeltas(data));
  return errors;
};

const sheetShapeErrors = (sheet, where) => (isObject(sheet) && Object.keys(sheet).sort().join() === SHEET_KEYS.join()
  && Array.isArray(sheet.variants) && sheet.variants.length > 0 ? [] : [`${where}: previous technical_sheet must have exactly ${SHEET_KEYS.join(', ')} and variants`]);

// Task 3c.27: delta steps on top of the already applied 027 data.
const validateDeltas = (data) => {
  if (!('deltas' in data)) return [];
  if (!Array.isArray(data.deltas)) return ['deltas must be an array'];
  const errors = [];
  const items = new Map((Array.isArray(data.items) ? data.items : []).filter(isObject).map((item) => [item.sku, item]));
  const deltaOf = new Map();
  const ids = new Set();
  data.deltas.forEach((delta, index) => {
    const where = `deltas[${index}]${delta?.id ? ` (${delta.id})` : ''}`;
    if (!isObject(delta)) {
      errors.push(`${where}: must be an object`);
      return;
    }
    if (typeof delta.id !== 'string' || !/^\d{3}$/.test(delta.id) || Number(delta.id) <= 27 || ids.has(delta.id)) {
      errors.push(`${where}: id must be a unique three-digit number after 027`);
    }
    ids.add(delta.id);
    if (typeof delta.name !== 'string' || !/^[a-z0-9_]+$/.test(delta.name)) errors.push(`${where}: name must match [a-z0-9_]+`);
    if (typeof delta.task !== 'string' || delta.task.trim() === '') errors.push(`${where}: task is required`);
    if (!isStringList(delta.skus) || delta.skus.length === 0 || new Set(delta.skus).size !== delta.skus.length) {
      errors.push(`${where}: skus must be a non-empty list of distinct skus`);
    }
    const previous = isObject(delta.previous_technical_sheets) ? delta.previous_technical_sheets : null;
    if (!previous) errors.push(`${where}: previous_technical_sheets must be an object`);
    for (const sku of Array.isArray(delta.skus) ? delta.skus : []) {
      const item = items.get(sku);
      if (!item) {
        errors.push(`${where}: unknown sku ${sku}`);
        continue;
      }
      if (deltaOf.has(sku)) errors.push(`${where}: ${sku} is already in delta ${deltaOf.get(sku)}`);
      deltaOf.set(sku, delta.id);
      if (!['update', 'create'].includes(item.action)) errors.push(`${where}: ${sku}: a delta carries only update and create items`);
      if (item.action === 'update' && previous) {
        if (!(sku in previous)) errors.push(`${where}: ${sku} needs its previous technical_sheet`);
        else if (JSON.stringify(previous[sku]) === JSON.stringify(item.technical_sheet)) errors.push(`${where}: ${sku}: the previous technical_sheet equals the new one`);
      }
    }
    for (const [sku, sheet] of Object.entries(previous || {})) {
      if (!(Array.isArray(delta.skus) && delta.skus.includes(sku) && items.get(sku)?.action === 'update')) {
        errors.push(`${where}: previous_technical_sheets lists only updated skus of this delta (${sku})`);
      }
      errors.push(...sheetShapeErrors(sheet, `${where}.${sku}`));
    }
    for (const found of findPriceLike(previous || {}, `${where}.previous_technical_sheets`)) errors.push(`price-like data is not allowed: ${found}`);
  });
  return errors;
};

const literal = (value) => `'${String(value).replace(/'/g, "''")}'`;
const jsonLiteral = (value) => `${literal(JSON.stringify(value))}::jsonb`;
const textArray = (values) => `ARRAY[${values.map(literal).join(', ')}]::text[]`;
const skuList = (skus) => skus.map(literal).join(', ');
const assertValid = (data) => {
  const errors = validateTechnicalSheetsData(data);
  if (errors.length > 0) throw new Error(`invalid technical sheets data:\n- ${errors.join('\n- ')}`);
};
const byAction = (data, action) => data.items.filter((item) => item.action === action);

const createStatement = (created, marker) => {
  const rows = created.map((item) => `  (${[
    literal(item.sku), literal(item.name), literal(item.item_type), literal(item.category_code),
    literal(item.short_description), textArray(item.service_keywords), textArray(item.applicable_cities),
    jsonLiteral(item.restrictions),
    jsonLiteral({ [marker]: 'created', ...(item.synonyms ? { synonyms: item.synonyms } : {}) }),
  ].join(', ')})`).join(',\n');
  return `-- 1. New catalog items (a sku that already exists is left alone).
INSERT INTO catalog_items (
  category_id, sku, name, item_type, short_description,
  service_keywords, applicable_cities, restrictions, metadata
)
SELECT
  (SELECT cc.id FROM catalog_categories cc WHERE cc.code = data.category_code),
  data.sku, data.name, data.item_type, data.short_description,
  data.service_keywords, data.applicable_cities, data.restrictions, data.metadata
FROM (VALUES
${rows}
) AS data(sku, name, item_type, category_code, short_description, service_keywords, applicable_cities, restrictions, metadata)
ON CONFLICT (sku) DO NOTHING;
`;
};
const sheetsStatement = (items) => {
  const sheetRows = items.map((item) => `  (${literal(item.sku)}, ${jsonLiteral(item.technical_sheet)})`).join(',\n');
  return `-- 3. Technical sheets, only where they differ.
UPDATE catalog_items AS ci
SET
  metadata = jsonb_set(COALESCE(ci.metadata, '{}'::jsonb), '{technical_sheet}', data.technical_sheet, TRUE)
FROM (VALUES
${sheetRows}
) AS data(sku, technical_sheet)
WHERE ci.sku = data.sku
  AND ci.metadata->'technical_sheet' IS DISTINCT FROM data.technical_sheet;
`;
};

export const buildMigrationSql = (data) => {
  assertValid(data);
  const created = byAction(data, 'create');
  const reactivated = byAction(data, 'reactivate');
  const statements = [`-- Catalog technical sheets (task 3c.20). PRIVATE generated SQL: never commit it.
-- GENERATED by scripts/catalog/technical-sheets.mjs; see that file for the data
-- shape, the apply/rollback commands and the idempotency rules.
`];
  if (created.length > 0) statements.push(createStatement(created, MARKER));
  for (const item of reactivated) {
    const synonyms = item.synonyms
      ? `jsonb_set(COALESCE(metadata, '{}'::jsonb), '{synonyms}', ${jsonLiteral(item.synonyms)}, TRUE)`
      : `COALESCE(metadata, '{}'::jsonb)`;
    statements.push(`-- 2. Reactivate ${item.sku}, only while it is inactive and not deleted.
UPDATE catalog_items
SET
  is_active = TRUE,
  metadata = ${synonyms}
    || '{"${MARKER}": "reactivated"}'::jsonb
WHERE sku = ${literal(item.sku)}
  AND NOT is_active
  AND deleted_at IS NULL;
`);
  }
  statements.push(sheetsStatement(data.items));
  return statements.join('\n');
};

export const buildRollbackSql = (data) => {
  assertValid(data);
  const created = byAction(data, 'create').map((item) => item.sku);
  const reactivated = byAction(data, 'reactivate');
  const statements = [`-- Rollback of the catalog technical sheets SQL (task 3c.20). PRIVATE generated SQL: never commit it.
-- GENERATED by scripts/catalog/technical-sheets.mjs. Restores the prior rows exactly (updated_at aside).
`];
  if (created.length > 0) {
    statements.push(`DELETE FROM catalog_items
WHERE metadata->>'${MARKER}' = 'created'
  AND sku IN (${skuList(created)});
`);
  }
  for (const item of reactivated) {
    statements.push(`UPDATE catalog_items
SET
  is_active = FALSE,
  metadata = metadata${item.synonyms ? " - 'synonyms'" : ''} - '${MARKER}'
WHERE sku = ${literal(item.sku)}
  AND metadata->>'${MARKER}' = 'reactivated';
`);
  }
  for (const delta of data.deltas || []) {
    const deltaCreated = deltaItems(data, delta).filter((item) => item.action === 'create').map((item) => item.sku);
    if (deltaCreated.length === 0) continue;
    statements.push(`DELETE FROM catalog_items
WHERE metadata->>'${markerFor(delta.id)}' = 'created'
  AND sku IN (${skuList(deltaCreated)});
`);
  }
  statements.push(`UPDATE catalog_items
SET
  metadata = metadata - 'technical_sheet'
WHERE metadata ? 'technical_sheet'
  AND sku IN (${skuList(data.items.map((item) => item.sku))});
`);
  return statements.join('\n');
};

const deltaItems = (data, delta) => delta.skus.map((sku) => data.items.find((item) => item.sku === sku));
const findDelta = (data, id) => {
  assertValid(data);
  const delta = (data.deltas || []).find((candidate) => candidate.id === id);
  if (!delta) throw new Error(`no delta ${id} in the technical sheets data`);
  return delta;
};

// Task 3c.27: the private SQL of one delta step (apply after the 027 SQL).
export const buildDeltaMigrationSql = (data, id) => {
  const delta = findDelta(data, id);
  const items = deltaItems(data, delta);
  const created = items.filter((item) => item.action === 'create');
  const statements = [`-- Catalog technical sheets, delta ${delta.id} "${delta.name}" (task ${delta.task}). PRIVATE generated SQL: never commit it.
-- GENERATED by scripts/catalog/technical-sheets.mjs; apply it after the 027 SQL. Touches only: ${delta.skus.join(', ')}.
`];
  if (created.length > 0) statements.push(createStatement(created, markerFor(delta.id)));
  statements.push(sheetsStatement(items));
  return statements.join('\n');
};

// Task 3c.27: the rollback of one delta step (run it before any 027 rollback).
export const buildDeltaRollbackSql = (data, id) => {
  const delta = findDelta(data, id);
  const items = deltaItems(data, delta);
  const created = items.filter((item) => item.action === 'create').map((item) => item.sku);
  const updated = items.filter((item) => item.action === 'update');
  const statements = [`-- Rollback of the catalog technical sheets delta ${delta.id} "${delta.name}" (task ${delta.task}). PRIVATE generated SQL: never commit it.
-- GENERATED by scripts/catalog/technical-sheets.mjs. Restores the rows the 027 SQL left (updated_at aside).
`];
  if (created.length > 0) {
    statements.push(`DELETE FROM catalog_items
WHERE (metadata->>'${markerFor(delta.id)}' = 'created' OR metadata->>'${MARKER}' = 'created')
  AND sku IN (${skuList(created)});
`);
  }
  if (updated.length > 0) {
    const rows = updated.map((item) => `  (${literal(item.sku)}, ${jsonLiteral(item.technical_sheet)}, ${jsonLiteral(delta.previous_technical_sheets[item.sku])})`).join(',\n');
    statements.push(`UPDATE catalog_items AS ci
SET
  metadata = jsonb_set(ci.metadata, '{technical_sheet}', data.previous_technical_sheet, TRUE)
FROM (VALUES
${rows}
) AS data(sku, new_technical_sheet, previous_technical_sheet)
WHERE ci.sku = data.sku
  AND ci.metadata->'technical_sheet' = data.new_technical_sheet;
`);
  }
  return statements.join('\n');
};

export const rollbackPathFor = (applyPath) => applyPath.replace(/\.sql$/, '.down.sql');
export const deltaPathFor = (applyPath, delta) => path.join(path.dirname(applyPath), `${delta.id}_catalog_${delta.name}.sql`);

const argValue = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
};

const main = () => {
  const dataPath = path.resolve(repoRoot, argValue('--data', DEFAULT_DATA_PATH));
  const applyPath = path.resolve(repoRoot, argValue('--out', DEFAULT_APPLY_PATH));
  if (!fs.existsSync(dataPath)) {
    console.error(`private data file not found: ${path.relative(repoRoot, dataPath)} (it is never committed; ask the owner for it)`);
    process.exit(1);
  }
  const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  const errors = validateTechnicalSheetsData(data);
  if (errors.length > 0) {
    console.error(`invalid technical sheets data:\n- ${errors.join('\n- ')}`);
    process.exit(1);
  }
  const outputs = [[applyPath, buildMigrationSql(data)], [rollbackPathFor(applyPath), buildRollbackSql(data)]];
  for (const delta of data.deltas || []) {
    const deltaPath = deltaPathFor(applyPath, delta);
    outputs.push([deltaPath, buildDeltaMigrationSql(data, delta.id)], [rollbackPathFor(deltaPath), buildDeltaRollbackSql(data, delta.id)]);
  }
  if (process.argv.includes('--check')) {
    const stale = outputs.filter(([file, sql]) => !fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== sql);
    if (stale.length > 0) {
      console.error(`stale or missing: ${stale.map(([file]) => path.relative(repoRoot, file)).join(', ')}`);
      process.exit(1);
    }
    console.log(`technical sheets SQL is up to date (${data.items.length} items)`);
    return;
  }
  for (const [file, sql] of outputs) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, sql);
    console.log(`wrote ${path.relative(repoRoot, file)}`);
  }
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
