import fs from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';
import {
  fold, livePublicSynonymRows, rows026, rows028, MIGRATION_029_PATH, parseMoveRows,
} from '../support/catalog-synonym-migrations.mjs';

const require = createRequire(import.meta.url);
const { productRefsMentionedV31 } = require('../fixtures/workflow-nodes/shared/v3-contract-runtime.js');

// -----------------------------------------------------------------------------
// Task 3c.27 (owner decision): "Baldosa Minvu" is only the tactile MINVU tiles.
// Every other tile moves to a new product "Baldosas" (sku baldosas), created by
// the PRIVATE catalog data. Migration 029 moves the generic phrases "baldosa",
// "baldosas" and "baldosa de vereda" off baldosa-minvu (the new product owns
// them: "Baldosas" is its name, the other two are its private synonyms) and
// appends the tactile phrases. The sku and name of baldosa-minvu never change.
//
// Longest match: "baldosa minvu" / "baldosas minvu" / "baldosa táctil" name
// Baldosa Minvu; "baldosa", "baldosas", "baldosa lisa" name Baldosas.
// Uniqueness is checked against the public lists and, when the private data
// file exists locally (never in CI), against its products and synonyms.
// -----------------------------------------------------------------------------

const ROLLBACK_PATH = 'infra/postgres/rollback/029_baldosa_minvu_synonyms.down.sql';
const PRIVATE_DATA_PATH = 'db/seeds/private/technical_sheets.json';
const migrationSql = fs.readFileSync(MIGRATION_029_PATH, 'utf8');
const rollbackSql = fs.readFileSync(ROLLBACK_PATH, 'utf8');
const moves = parseMoveRows(migrationSql);
const [move] = moves;

const captured = JSON.parse(fs.readFileSync('tests/fixtures/v3-line-items/captured-distributive-ambiguous.json', 'utf8'));
const ACTIVE_PRODUCTS = captured.policy.grounding.catalog
  .filter((entry) => entry.concept === 'product')
  .map((entry) => ({ sku: entry.ref.slice('product:'.length), name: entry.value }));

const privatePresent = fs.existsSync(PRIVATE_DATA_PATH);
const privateItems = privatePresent ? JSON.parse(fs.readFileSync(PRIVATE_DATA_PATH, 'utf8')).items : [];

const catalogOf = (products, synonymRows) => {
  const bySku = new Map(synonymRows.map((row) => [row.sku, row.synonyms]));
  return products.map((product) => ({
    ref: `product:${product.sku}`, concept: 'product', value: product.name, synonyms: bySku.get(product.sku) || [],
  }));
};
const mentioned = (catalog, text) => [...productRefsMentionedV31(catalog, text)].sort();

describe('029_baldosa_minvu_synonyms data', () => {
  test('targets only baldosa-minvu: removes the generic phrases, adds the tactile ones', () => {
    expect(moves.map((row) => row.sku)).toEqual(['baldosa-minvu']);
    expect(move.removed).toEqual(['baldosa', 'baldosas', 'baldosa de vereda']);
    expect(move.added).toEqual([
      'baldosa minvu táctil', 'baldosa táctil', 'baldosas táctiles', 'baldosa podotáctil', 'baldosas podotáctiles',
    ]);
    for (const phrase of [...move.removed, ...move.added]) expect(phrase, phrase).toBe(phrase.trim());
    expect(new Set(move.added.map(fold)).size).toBe(move.added.length);
  });

  test('every removed phrase was a 026 synonym of baldosa-minvu; no added phrase was', () => {
    const before = rows026().find((row) => row.sku === 'baldosa-minvu').synonyms;
    for (const phrase of move.removed) expect(before, phrase).toContain(phrase);
    for (const phrase of move.added) expect(before.map(fold), phrase).not.toContain(fold(phrase));
  });

  test('baldosa-minvu keeps "baldosas minvu" and ends with exactly the MINVU phrases', () => {
    const live = livePublicSynonymRows().find((row) => row.sku === 'baldosa-minvu').synonyms;
    expect(live).toEqual(['baldosas minvu', ...move.added]);
  });

  test('the live public lists stay unique and never equal a product name', () => {
    const owners = new Map();
    const names = new Map(ACTIVE_PRODUCTS.map((product) => [fold(product.name), product.sku]));
    for (const { sku, synonyms } of livePublicSynonymRows()) {
      for (const synonym of synonyms) {
        const key = fold(synonym);
        expect(owners.get(key) ?? sku, `"${synonym}" is claimed by ${owners.get(key)} and ${sku}`).toBe(sku);
        owners.set(key, sku);
        expect(names.has(key), `${sku}: "${synonym}" equals the name of ${names.get(key)}`).toBe(false);
      }
    }
    // 028 is untouched.
    expect(rows028().map((row) => row.sku)).toEqual(['cierros-hormigon']);
  });

  test('on the public catalog, MINVU phrases name Baldosa Minvu and the generic word names nothing', () => {
    const catalog = catalogOf(ACTIVE_PRODUCTS, livePublicSynonymRows());
    for (const text of ['baldosa minvu', 'Baldosas Minvu', 'quiero baldosa táctil', 'baldosas tactiles', 'baldosa podotáctil', 'Baldosa Minvu táctil']) {
      expect(mentioned(catalog, text), text).toEqual(['product:baldosa-minvu']);
    }
    // Without the private product a fresh database has no product for "baldosa".
    expect(mentioned(catalog, 'necesito baldosas')).toEqual([]);
  });
});

describe('029 with the new Baldosas product (synthetic, public phrases only)', () => {
  // Mirrors the owner decision: the private product "Baldosas" holds "baldosa"
  // and "baldosa de vereda"; "baldosas" is its name.
  const products = [...ACTIVE_PRODUCTS, { sku: 'baldosas', name: 'Baldosas' }];
  const catalog = catalogOf(products, [...livePublicSynonymRows(), { sku: 'baldosas', synonyms: ['baldosa', 'baldosa de vereda'] }]);

  test.each([
    ['Baldosas', 'product:baldosas'],
    ['quiero baldosas', 'product:baldosas'],
    ['una baldosa lisa', 'product:baldosas'],
    ['baldosa de vereda', 'product:baldosas'],
    ['baldosa minvu', 'product:baldosa-minvu'],
    ['Baldosas Minvu', 'product:baldosa-minvu'],
    ['baldosa táctil', 'product:baldosa-minvu'],
    ['baldosas podotáctiles amarillas', 'product:baldosa-minvu'],
  ])('"%s" names %s', (text, ref) => {
    expect(mentioned(catalog, text)).toEqual([ref]);
  });

  test('naming both products names both', () => {
    expect(mentioned(catalog, 'baldosas lisas y baldosa minvu')).toEqual(['product:baldosa-minvu', 'product:baldosas']);
  });
});

describe.skipIf(!privatePresent)('029 against the private data (local only)', () => {
  const created = privateItems.filter((item) => item.action === 'create' && item.item_type === 'product');
  const products = [...ACTIVE_PRODUCTS, ...created.map((item) => ({ sku: item.sku, name: item.name }))];
  const privateRows = privateItems.filter((item) => Array.isArray(item.synonyms)).map((item) => ({ sku: item.sku, synonyms: item.synonyms }));
  const catalog = catalogOf(products, [...livePublicSynonymRows(), ...privateRows]);
  const baldosas = privateItems.find((item) => item.sku === 'baldosas');
  const minvu = privateItems.find((item) => item.sku === 'baldosa-minvu');

  test('the private data creates Baldosas, which owns every phrase 029 removes', () => {
    expect(baldosas).toMatchObject({ action: 'create', name: 'Baldosas', item_type: 'product' });
    const owned = [fold(baldosas.name), ...baldosas.synonyms.map(fold)];
    for (const phrase of move.removed) expect(owned, phrase).toContain(fold(phrase));
  });

  test('no phrase (public or private) belongs to two products, and the 029 phrases are free', () => {
    const owners = new Map();
    for (const { sku, synonyms } of [...livePublicSynonymRows(), ...privateRows]) {
      for (const synonym of synonyms) {
        const key = fold(synonym);
        expect(owners.get(key) ?? sku, `"${synonym}"`).toBe(sku);
        owners.set(key, sku);
      }
    }
    const names = new Set(products.map((product) => fold(product.name)));
    for (const phrase of move.added) expect(names.has(fold(phrase)), phrase).toBe(false);
  });

  test('resolution on the full catalog', () => {
    for (const text of ['baldosa', 'Baldosas', 'baldosa lisa', 'baldosa de vereda']) {
      expect(mentioned(catalog, text), text).toEqual(['product:baldosas']);
    }
    for (const text of ['baldosa minvu', 'baldosas minvu', 'baldosa táctil', 'baldosas podotáctiles']) {
      expect(mentioned(catalog, text), text).toEqual(['product:baldosa-minvu']);
    }
  });

  test('every Baldosas variant name names Baldosas; a MINVU variant named with a 029 phrase names Baldosa Minvu', () => {
    for (const variant of baldosas.technical_sheet.variants) {
      expect(mentioned(catalog, variant.name), variant.name).toEqual(['product:baldosas']);
    }
    const phrased = minvu.technical_sheet.variants
      .filter((variant) => move.added.some((phrase) => ` ${fold(variant.name).replace(/[^a-z0-9]+/g, ' ')} `.includes(` ${fold(phrase)} `)));
    expect(phrased.length).toBeGreaterThan(0);
    for (const variant of phrased) expect(mentioned(catalog, variant.name), variant.name).toEqual(['product:baldosa-minvu']);
  });
});

describe('029_baldosa_minvu_synonyms SQL shape', () => {
  test('keyed by sku, only rewrites metadata.synonyms, idempotent', () => {
    expect(migrationSql).toMatch(/WHERE ci\.sku = data\.sku/);
    expect(migrationSql).toMatch(/jsonb_set\(\s*COALESCE\(ci\.metadata, '\{\}'::jsonb\),\s*'\{synonyms\}'/);
    // A row is touched only while it still holds a removed phrase or lacks an added one.
    expect(migrationSql).toMatch(/COALESCE\(ci\.metadata->'synonyms', '\[\]'::jsonb\) \?\| ARRAY\(SELECT jsonb_array_elements_text\(data\.removed\)\)/);
    expect(migrationSql).toMatch(/NOT \(COALESCE\(ci\.metadata->'synonyms', '\[\]'::jsonb\) @> data\.added\)/);
    expect(migrationSql).not.toMatch(/metadata\s*=\s*'/);
    expect(migrationSql).not.toMatch(/\b(?:INSERT|DELETE|ALTER|DROP)\b/i);
  });

  test('the rollback lives outside migrations/ and swaps exactly the same phrases back', () => {
    expect(fs.existsSync('infra/postgres/migrations/029_baldosa_minvu_synonyms.down.sql')).toBe(false);
    const [back] = parseMoveRows(rollbackSql);
    expect(parseMoveRows(rollbackSql)).toHaveLength(1);
    expect(back).toEqual({ sku: 'baldosa-minvu', removed: move.added, added: move.removed });
    expect(rollbackSql).not.toMatch(/\b(?:INSERT|DELETE|ALTER|DROP)\b/i);
  });
});
