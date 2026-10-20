import fs from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const { productRefsMentionedV31 } = require('../fixtures/workflow-nodes/shared/v3-contract-runtime.js');

// -----------------------------------------------------------------------------
// Task 3c.19 (live 2026-09-29): the customer wrote "Bloques de cemento", the
// model only knew the catalog name "Bloques de Hormigón", asked whether that
// was what they meant, and then said it could not confirm it was the same
// thing. Migration 026 stores unambiguous synonyms per product in
// catalog_items.metadata.synonyms. A term shared by several products
// (pandereta, placa, poste, alambre...) is never a synonym, so it keeps the
// clarification flow.
// -----------------------------------------------------------------------------

const MIGRATION_PATH = 'infra/postgres/migrations/026_catalog_product_synonyms.sql';
const ROLLBACK_PATH = 'infra/postgres/rollback/026_catalog_product_synonyms.down.sql';
const migrationSql = fs.readFileSync(MIGRATION_PATH, 'utf8');
const rollbackSql = fs.readFileSync(ROLLBACK_PATH, 'utf8');

// The live active catalog as captured in production (2026-09-28).
const captured = JSON.parse(fs.readFileSync('tests/fixtures/v3-line-items/captured-distributive-ambiguous.json', 'utf8'));
const ACTIVE_PRODUCTS = captured.policy.grounding.catalog
  .filter((entry) => entry.concept === 'product')
  .map((entry) => ({ sku: entry.ref.slice('product:'.length), ref: entry.ref, name: entry.value }));

const fold = (value) => String(value).normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLocaleLowerCase('es').replace(/\s+/g, ' ').trim();
const containsPhrase = (text, phrase) => ` ${fold(text).replace(/[^a-z0-9]+/g, ' ')} `
  .includes(` ${fold(phrase).replace(/[^a-z0-9]+/g, ' ').trim()} `);

const parseSynonymRows = (sql) => [...sql.matchAll(/\(\s*'([a-z0-9-]+)',\s*'(\[[^']*\])'::jsonb\s*\)/g)]
  .map(([, sku, json]) => ({ sku, synonyms: JSON.parse(json) }));
const rows = parseSynonymRows(migrationSql);
const synonymsBySku = new Map(rows.map((row) => [row.sku, row.synonyms]));

// Generic words that several products share: they must keep asking.
const SHARED_GENERIC_TERMS = [
  'pandereta', 'panderetas', 'placa', 'placas', 'poste', 'postes', 'alambre', 'alambres',
  'cierre', 'cierres', 'cierro', 'cierros', 'hormigon', 'concreto', 'cemento', 'borde', 'bordes',
  'tapa', 'tapas', 'bloque', 'bloques', 'maceta', 'macetas', 'base', 'pilar',
];

describe('026_catalog_product_synonyms data', () => {
  test('covers exactly the 24 active products, once each', () => {
    expect(ACTIVE_PRODUCTS).toHaveLength(24);
    expect(rows.map((row) => row.sku).sort()).toEqual(ACTIVE_PRODUCTS.map((product) => product.sku).sort());
    expect(new Set(rows.map((row) => row.sku)).size).toBe(rows.length);
  });

  test('every product carries a non-empty array of distinct, trimmed, non-empty strings', () => {
    for (const { sku, synonyms } of rows) {
      expect(Array.isArray(synonyms), sku).toBe(true);
      expect(synonyms.length, sku).toBeGreaterThan(0);
      for (const synonym of synonyms) {
        expect(typeof synonym, sku).toBe('string');
        expect(synonym, sku).toBe(synonym.trim());
        expect(synonym.length, sku).toBeGreaterThan(0);
      }
      expect(new Set(synonyms.map(fold)).size, `${sku} repeats a synonym after folding`).toBe(synonyms.length);
    }
  });

  test('no synonym (accent/case folded) maps to more than one product', () => {
    const owners = new Map();
    for (const { sku, synonyms } of rows) {
      for (const synonym of synonyms) {
        const key = fold(synonym);
        expect(owners.get(key) ?? sku, `"${synonym}" is claimed by ${owners.get(key)} and ${sku}`).toBe(sku);
        owners.set(key, sku);
      }
    }
  });

  test('no synonym equals any product name (its own is redundant, another one is a collision)', () => {
    const names = new Map(ACTIVE_PRODUCTS.map((product) => [fold(product.name), product.sku]));
    for (const { sku, synonyms } of rows) {
      for (const synonym of synonyms) {
        expect(names.has(fold(synonym)), `${sku}: "${synonym}" equals the name of ${names.get(fold(synonym))}`).toBe(false);
      }
    }
  });

  test('a synonym inside another product name never steals that name (longest match)', () => {
    const catalog = ACTIVE_PRODUCTS.map((product) => ({
      ref: product.ref, concept: 'product', value: product.name, synonyms: synonymsBySku.get(product.sku),
    }));
    const overlaps = [];
    for (const { sku, synonyms } of rows) {
      for (const synonym of synonyms) {
        for (const product of ACTIVE_PRODUCTS.filter((candidate) => candidate.sku !== sku)) {
          if (!containsPhrase(product.name, synonym)) continue;
          overlaps.push(`${synonym} < ${product.name}`);
          expect([...productRefsMentionedV31(catalog, product.name)], `"${product.name}"`).toEqual([product.ref]);
        }
      }
    }
    // The only overlap is the documented "placa de 50" family.
    expect(overlaps).toEqual(['placas de 50 < Placas de 50 cm Reforzadas']);
  });

  test('every product name, written alone, names exactly that product', () => {
    const catalog = ACTIVE_PRODUCTS.map((product) => ({
      ref: product.ref, concept: 'product', value: product.name, synonyms: synonymsBySku.get(product.sku),
    }));
    for (const product of ACTIVE_PRODUCTS) {
      expect([...productRefsMentionedV31(catalog, product.name)], product.name).toEqual([product.ref]);
    }
  });

  test('shared generic terms are never synonyms, so they keep the clarification flow', () => {
    const folded = new Set(rows.flatMap((row) => row.synonyms.map(fold)));
    for (const term of SHARED_GENERIC_TERMS) expect(folded.has(term), term).toBe(false);
  });

  test('carries the synonyms the live conversation needed', () => {
    expect(synonymsBySku.get('bloques-hormigon')).toEqual(expect.arrayContaining(['bloques de cemento', 'bloque de cemento']));
  });

  test('every synonym, written alone, names exactly its own product under longest-match semantics', () => {
    const catalog = ACTIVE_PRODUCTS.map((product) => ({
      ref: product.ref, concept: 'product', value: product.name, synonyms: synonymsBySku.get(product.sku),
    }));
    for (const { sku, synonyms } of rows) {
      for (const synonym of synonyms) {
        expect([...productRefsMentionedV31(catalog, `quiero ${synonym} por favor`)], synonym).toEqual([`product:${sku}`]);
      }
    }
  });

  test('the overlapping "placa de 50" family resolves to the longest phrase', () => {
    const catalog = ACTIVE_PRODUCTS.map((product) => ({
      ref: product.ref, concept: 'product', value: product.name, synonyms: synonymsBySku.get(product.sku),
    }));
    expect([...productRefsMentionedV31(catalog, 'necesito placa de 50 reforzada')]).toEqual(['product:placas-50-cm-reforzadas']);
    expect([...productRefsMentionedV31(catalog, 'necesito placa de 50 cm reforzada')]).toEqual(['product:placas-50-cm-reforzadas']);
    expect([...productRefsMentionedV31(catalog, 'necesito placa de 50')]).toEqual(['product:placas-50-cm']);
    expect([...productRefsMentionedV31(catalog, 'una placa de 50 y una placa reforzada')].sort())
      .toEqual(['product:placas-50-cm', 'product:placas-50-cm-reforzadas']);
    // "cemento" (the bag product's name) inside "bloques de cemento" is not a mention of Cemento.
    expect([...productRefsMentionedV31(catalog, 'Bloques de cemento')]).toEqual(['product:bloques-hormigon']);
    expect([...productRefsMentionedV31(catalog, 'bloques de cemento y 3 sacos de cemento')].sort())
      .toEqual(['product:bloques-hormigon', 'product:cemento']);
    // Generic shared words name nothing.
    expect([...productRefsMentionedV31(catalog, 'necesito pandereta con placa y poste')]).toEqual([]);
  });
});

describe('026_catalog_product_synonyms SQL shape', () => {
  test('only sets metadata.synonyms, keyed by sku, and is idempotent', () => {
    expect(migrationSql).toContain("jsonb_set(COALESCE(ci.metadata, '{}'::jsonb), '{synonyms}', data.synonyms, TRUE)");
    expect(migrationSql).toMatch(/WHERE ci\.sku = data\.sku/);
    expect(migrationSql).toMatch(/ci\.metadata->'synonyms' IS DISTINCT FROM data\.synonyms/);
    expect(migrationSql).not.toMatch(/metadata\s*=\s*'/);
    expect(migrationSql).not.toMatch(/\b(?:INSERT|DELETE|ALTER|DROP)\b/i);
  });

  test('the rollback lives outside migrations/ and only removes the synonyms key of the same skus', () => {
    expect(fs.existsSync('infra/postgres/migrations/026_catalog_product_synonyms.down.sql')).toBe(false);
    expect(rollbackSql).toContain("metadata = metadata - 'synonyms'");
    expect(rollbackSql).toContain("metadata ? 'synonyms'");
    const rollbackSkus = [...rollbackSql.matchAll(/'([a-z0-9-]+)'/g)].map(([, sku]) => sku)
      .filter((sku) => synonymsBySku.has(sku));
    expect([...new Set(rollbackSkus)].sort()).toEqual([...synonymsBySku.keys()].sort());
    expect(rollbackSql).not.toMatch(/\b(?:INSERT|DELETE|ALTER|DROP)\b/i);
  });
});
