import fs from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const { productRefsMentionedV31 } = require('../fixtures/workflow-nodes/shared/v3-contract-runtime.js');

// -----------------------------------------------------------------------------
// Task 3c.21 (owner rule): a customer who says "muro"/"muros" without naming
// another product means Cierros de Hormigón. Migration 028 appends "muro"-type
// synonyms to cierros-hormigon's metadata.synonyms (026 keeps the rest). The
// product the private technical-sheet data creates for camellón walls keeps
// its own, longer phrases, so longest match still wins there.
//
// Uniqueness is checked against the public 026 lists and, when the private
// data file exists locally (never in CI), against its products and synonyms.
// -----------------------------------------------------------------------------

const MIGRATION_PATH = 'infra/postgres/migrations/028_cierros_muro_synonyms.sql';
const ROLLBACK_PATH = 'infra/postgres/rollback/028_cierros_muro_synonyms.down.sql';
const PRIVATE_DATA_PATH = 'db/seeds/private/technical_sheets.json';
const migrationSql = fs.readFileSync(MIGRATION_PATH, 'utf8');
const rollbackSql = fs.readFileSync(ROLLBACK_PATH, 'utf8');

const parseSynonymRows = (sql) => [...sql.matchAll(/\(\s*'([a-z0-9-]+)',\s*'(\[[^']*\])'::jsonb\s*\)/g)]
  .map(([, sku, json]) => ({ sku, synonyms: JSON.parse(json) }));
const rows028 = parseSynonymRows(migrationSql);
const rows026 = parseSynonymRows(fs.readFileSync('infra/postgres/migrations/026_catalog_product_synonyms.sql', 'utf8'));
const MURO_SYNONYMS = rows028[0]?.synonyms ?? [];

const captured = JSON.parse(fs.readFileSync('tests/fixtures/v3-line-items/captured-distributive-ambiguous.json', 'utf8'));
const ACTIVE_PRODUCTS = captured.policy.grounding.catalog
  .filter((entry) => entry.concept === 'product')
  .map((entry) => ({ sku: entry.ref.slice('product:'.length), name: entry.value }));

const privatePresent = fs.existsSync(PRIVATE_DATA_PATH);
const privateItems = privatePresent ? JSON.parse(fs.readFileSync(PRIVATE_DATA_PATH, 'utf8')).items : [];
const privateProducts = privateItems.filter((item) => item.action === 'create' && item.item_type === 'product')
  .map((item) => ({ sku: item.sku, name: item.name }));
const privateSynonymRows = privateItems.filter((item) => Array.isArray(item.synonyms))
  .map((item) => ({ sku: item.sku, synonyms: item.synonyms }));

const fold = (value) => String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLocaleLowerCase('es').replace(/\s+/g, ' ').trim();
const containsPhrase = (text, phrase) => ` ${fold(text).replace(/[^a-z0-9]+/g, ' ')} `
  .includes(` ${fold(phrase).replace(/[^a-z0-9]+/g, ' ').trim()} `);

// Merges synonym rows per sku the way 026 then 028 (then the private data) leave them live.
const mergedCatalog = (products, synonymRows) => {
  const bySku = new Map();
  for (const { sku, synonyms } of synonymRows) bySku.set(sku, [...(bySku.get(sku) || []), ...synonyms]);
  return {
    bySku,
    catalog: products.map((product) => ({
      ref: `product:${product.sku}`, concept: 'product', value: product.name, synonyms: bySku.get(product.sku) || [],
    })),
  };
};

const checkUniqueness = (products, synonymRows) => {
  const { bySku, catalog } = mergedCatalog(products, synonymRows);
  const owners = new Map();
  for (const [sku, synonyms] of bySku) {
    for (const synonym of synonyms) {
      const key = fold(synonym);
      expect(owners.get(key) ?? sku, `"${synonym}" is claimed by ${owners.get(key)} and ${sku}`).toBe(sku);
      owners.set(key, sku);
    }
  }
  const names = new Map(products.map((product) => [fold(product.name), product.sku]));
  for (const synonym of MURO_SYNONYMS) {
    expect(names.has(fold(synonym)), `"${synonym}" equals the name of ${names.get(fold(synonym))}`).toBe(false);
    expect([...productRefsMentionedV31(catalog, `quiero ${synonym} por favor`)], synonym).toEqual(['product:cierros-hormigon']);
  }
  // A 028 synonym inside another product name never steals it (longest match).
  for (const product of products.filter((candidate) => candidate.sku !== 'cierros-hormigon')) {
    if (!MURO_SYNONYMS.some((synonym) => containsPhrase(product.name, synonym))) continue;
    expect([...productRefsMentionedV31(catalog, product.name)], product.name).toEqual([`product:${product.sku}`]);
  }
  // Every other product's own synonyms still name only that product.
  for (const [sku, synonyms] of bySku) {
    for (const synonym of synonyms) {
      expect([...productRefsMentionedV31(catalog, `quiero ${synonym} por favor`)], synonym).toEqual([`product:${sku}`]);
    }
  }
};

describe('028_cierros_muro_synonyms data', () => {
  test('targets only cierros-hormigon with "muro"-type phrases', () => {
    expect(rows028.map((row) => row.sku)).toEqual(['cierros-hormigon']);
    expect(MURO_SYNONYMS).toEqual(expect.arrayContaining(['muro', 'muros', 'muro perimetral', 'muro prefabricado', 'muro de cierre']));
    for (const synonym of MURO_SYNONYMS) {
      expect(synonym, synonym).toBe(synonym.trim());
      expect(fold(synonym).startsWith('muro'), synonym).toBe(true);
    }
    expect(new Set(MURO_SYNONYMS.map(fold)).size).toBe(MURO_SYNONYMS.length);
  });

  test('never repeats a 026 synonym of cierros-hormigon', () => {
    const existing = new Set(rows026.find((row) => row.sku === 'cierros-hormigon').synonyms.map(fold));
    for (const synonym of MURO_SYNONYMS) expect(existing.has(fold(synonym)), synonym).toBe(false);
  });

  test('is unique against the public 026 lists and the active catalog', () => {
    checkUniqueness(ACTIVE_PRODUCTS, [...rows026, ...rows028]);
  });

  test('"muro" means cierros; bloques stay bloques', () => {
    const { catalog } = mergedCatalog(ACTIVE_PRODUCTS, [...rows026, ...rows028]);
    expect([...productRefsMentionedV31(catalog, 'Necesito un muro de 20 metros lineales')]).toEqual(['product:cierros-hormigon']);
    expect([...productRefsMentionedV31(catalog, 'bloques de cemento para 30 m2')]).toEqual(['product:bloques-hormigon']);
  });

  describe.skipIf(!privatePresent)('against the private data (local only)', () => {
    test('is unique against the private products and synonyms, and longer private phrases win', () => {
      const products = [...ACTIVE_PRODUCTS, ...privateProducts];
      checkUniqueness(products, [...rows026, ...rows028, ...privateSynonymRows]);
      // Private phrases that start with a 028 synonym resolve to their own product.
      const { catalog } = mergedCatalog(products, [...rows026, ...rows028, ...privateSynonymRows]);
      for (const { sku, synonyms } of privateSynonymRows) {
        for (const synonym of synonyms.filter((phrase) => MURO_SYNONYMS.some((muro) => containsPhrase(phrase, muro)))) {
          expect([...productRefsMentionedV31(catalog, `necesito 10 ${synonym}`)], synonym).toEqual([`product:${sku}`]);
        }
      }
    });
  });
});

describe('028_cierros_muro_synonyms SQL shape', () => {
  test('appends only the missing synonyms, keyed by sku, and is idempotent', () => {
    expect(migrationSql).toMatch(/WHERE ci\.sku = data\.sku/);
    expect(migrationSql).toMatch(/jsonb_set\(\s*COALESCE\(ci\.metadata, '\{\}'::jsonb\),\s*'\{synonyms\}'/);
    expect(migrationSql).toMatch(/NOT \(COALESCE\(ci\.metadata->'synonyms', '\[\]'::jsonb\) @> data\.synonyms\)/);
    expect(migrationSql).not.toMatch(/metadata\s*=\s*'/);
    expect(migrationSql).not.toMatch(/\b(?:INSERT|DELETE|ALTER|DROP)\b/i);
  });

  test('the rollback lives outside migrations/ and removes exactly the 028 synonyms from cierros-hormigon', () => {
    expect(fs.existsSync('infra/postgres/migrations/028_cierros_muro_synonyms.down.sql')).toBe(false);
    expect(rollbackSql).toContain("sku = 'cierros-hormigon'");
    const listed = [...rollbackSql.matchAll(/ARRAY\[([^\]]*)\]::text\[\]/g)]
      .flatMap(([, body]) => [...body.matchAll(/'([^']*)'/g)].map(([, value]) => value));
    expect([...new Set(listed)].sort()).toEqual([...MURO_SYNONYMS].sort());
    expect(rollbackSql).not.toMatch(/\b(?:INSERT|DELETE|ALTER|DROP)\b/i);
  });
});
