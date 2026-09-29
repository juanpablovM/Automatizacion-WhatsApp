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
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEFAULT_DATA_PATH = 'db/seeds/private/technical_sheets.json';
export const DEFAULT_APPLY_PATH = 'db/seeds/private/027_catalog_technical_sheets.sql';
export const MARKER = 'catalog_migration_027';

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

export const buildMigrationSql = (data) => {
  assertValid(data);
  const created = byAction(data, 'create');
  const reactivated = byAction(data, 'reactivate');
  const statements = [`-- Catalog technical sheets (task 3c.20). PRIVATE generated SQL: never commit it.
-- GENERATED by scripts/catalog/technical-sheets.mjs; see that file for the data
-- shape, the apply/rollback commands and the idempotency rules.
`];
  if (created.length > 0) {
    const rows = created.map((item) => `  (${[
      literal(item.sku), literal(item.name), literal(item.item_type), literal(item.category_code),
      literal(item.short_description), textArray(item.service_keywords), textArray(item.applicable_cities),
      jsonLiteral(item.restrictions),
      jsonLiteral({ [MARKER]: 'created', ...(item.synonyms ? { synonyms: item.synonyms } : {}) }),
    ].join(', ')})`).join(',\n');
    statements.push(`-- 1. New catalog items (a sku that already exists is left alone).
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
`);
  }
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
  const sheetRows = data.items.map((item) => `  (${literal(item.sku)}, ${jsonLiteral(item.technical_sheet)})`).join(',\n');
  statements.push(`-- 3. Technical sheets, only where they differ.
UPDATE catalog_items AS ci
SET
  metadata = jsonb_set(COALESCE(ci.metadata, '{}'::jsonb), '{technical_sheet}', data.technical_sheet, TRUE)
FROM (VALUES
${sheetRows}
) AS data(sku, technical_sheet)
WHERE ci.sku = data.sku
  AND ci.metadata->'technical_sheet' IS DISTINCT FROM data.technical_sheet;
`);
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
  statements.push(`UPDATE catalog_items
SET
  metadata = metadata - 'technical_sheet'
WHERE metadata ? 'technical_sheet'
  AND sku IN (${skuList(data.items.map((item) => item.sku))});
`);
  return statements.join('\n');
};

export const rollbackPathFor = (applyPath) => applyPath.replace(/\.sql$/, '.down.sql');

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
