import fs from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';
import {
  buildMigrationSql, buildRollbackSql, validateTechnicalSheetsData, rollbackPathFor, DEFAULT_DATA_PATH, DEFAULT_APPLY_PATH,
  buildDeltaMigrationSql, buildDeltaRollbackSql, deltaPathFor, deltaSteps,
} from '../../scripts/catalog/technical-sheets.mjs';
import { livePublicSynonymRows, rows028 } from '../support/catalog-synonym-migrations.mjs';

const require = createRequire(import.meta.url);
const { productRefsMentionedV31 } = require('../fixtures/workflow-nodes/shared/v3-contract-runtime.js');
const { buildV3PolicyInput } = require('../fixtures/workflow-nodes/shared/v3-policy-builder.js');

// -----------------------------------------------------------------------------
// Task 3c.20: validates the PRIVATE technical-sheet data file when it exists
// locally (db/seeds/private/ is gitignored, so CI skips this suite). Every
// product-specific expectation (terms that must never reach the model, markers
// of excluded documents, extra generic terms, active products without a sheet)
// is read from the private file's own `checks` block, so no real name or value
// lives in this tracked file.
// -----------------------------------------------------------------------------

const present = fs.existsSync(DEFAULT_DATA_PATH);
const data = present ? JSON.parse(fs.readFileSync(DEFAULT_DATA_PATH, 'utf8')) : { items: [], checks: {} };
const checks = data.checks || {};
const items = data.items;
const bySku = new Map(items.map((item) => [item.sku, item]));

// The live active catalog (public, captured 2026-09-28) and the public 026 synonym lists.
const captured = JSON.parse(fs.readFileSync('tests/fixtures/v3-line-items/captured-distributive-ambiguous.json', 'utf8'));
const ACTIVE_PRODUCTS = captured.policy.grounding.catalog
  .filter((entry) => entry.concept === 'product')
  .map((entry) => ({ sku: entry.ref.slice('product:'.length), name: entry.value }));
// Task 3c.21: 028 appends the "muro" synonyms to cierros-hormigon (owner rule).
// Task 3c.27: 029 moves the generic "baldosa" phrases off baldosa-minvu.
const synonyms028 = rows028();
const fold = (value) => String(value).normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLocaleLowerCase('es').replace(/\s+/g, ' ').trim();
const containsPhrase = (text, phrase) => ` ${fold(text).replace(/[^a-z0-9]+/g, ' ')} `
  .includes(` ${fold(phrase).replace(/[^a-z0-9]+/g, ' ').trim()} `);
const modelFacing = (item) => {
  const { source_files: _files, ...sheet } = item.technical_sheet;
  return JSON.stringify({ ...item, technical_sheet: sheet });
};

describe.skipIf(!present)('private technical sheets data (local only)', () => {
  const createdProducts = items.filter((item) => item.action === 'create' && item.item_type === 'product');
  const reactivated = items.filter((item) => item.action === 'reactivate');
  const activeAfter = [
    ...ACTIVE_PRODUCTS,
    ...reactivated.map((item) => ({ sku: item.sku, name: checks.reactivated_names?.[item.sku] })),
    ...createdProducts.map((item) => ({ sku: item.sku, name: item.name })),
  ];
  // The public lists as the live rows hold them (026, then 028 and 029), plus the private ones.
  const synonymRows = [...livePublicSynonymRows(), ...items.filter((item) => item.synonyms).map((item) => ({ sku: item.sku, synonyms: item.synonyms }))];
  const synonymsBySku = new Map();
  for (const row of synonymRows) synonymsBySku.set(row.sku, [...(synonymsBySku.get(row.sku) || []), ...row.synonyms]);
  // Owner decision 3c.21: these phrases name Cierros de Hormigón even where the
  // private checks still list them as shared generic terms.
  const ownerAssigned028 = new Set(synonyms028.flatMap((row) => row.synonyms.map(fold)));
  const catalog = activeAfter.map((product) => ({
    ref: `product:${product.sku}`, concept: 'product', value: product.name, synonyms: synonymsBySku.get(product.sku) || [],
  }));

  test('passes the generator validation (shape, no price-like data)', () => {
    expect(validateTechnicalSheetsData(data)).toEqual([]);
    expect(fs.readFileSync(DEFAULT_DATA_PATH, 'utf8')).not.toMatch(/\$/);
  });

  test('covers every active product except those declared without a sheet; existing rows are only updated', () => {
    for (const product of ACTIVE_PRODUCTS) {
      if ((checks.active_without_sheet || []).includes(product.sku)) {
        expect(bySku.has(product.sku), product.sku).toBe(false);
      } else {
        expect(bySku.get(product.sku)?.action, product.sku).toBe('update');
      }
    }
    for (const item of items.filter((candidate) => candidate.action === 'create')) {
      expect(ACTIVE_PRODUCTS.some((product) => product.sku === item.sku || fold(product.name) === fold(item.name)), item.sku).toBe(false);
    }
    for (const item of reactivated) expect(typeof checks.reactivated_names?.[item.sku], item.sku).toBe('string');
  });

  test('model-facing data never contains a forbidden term, nor anything from excluded documents', () => {
    const raw = fs.readFileSync(DEFAULT_DATA_PATH, 'utf8');
    for (const marker of checks.excluded_markers || []) {
      expect(JSON.stringify(items), marker).not.toContain(marker);
    }
    expect((checks.forbidden_model_terms || []).length).toBeGreaterThan(0);
    for (const item of items) {
      const text = fold(modelFacing(item));
      for (const term of checks.forbidden_model_terms) expect(text, `${item.sku}: ${term}`).not.toMatch(new RegExp(`\\b${fold(term)}\\b`));
    }
    expect(raw.length).toBeGreaterThan(0);
  });

  test('no synonym maps to more than one product, and none equals a product name', () => {
    const owners = new Map();
    const names = new Map(activeAfter.map((product) => [fold(product.name), product.sku]));
    expect(names.size).toBe(activeAfter.length);
    for (const { sku, synonyms } of synonymRows) {
      for (const synonym of synonyms) {
        const key = fold(synonym);
        expect(owners.get(key) ?? sku, `"${synonym}"`).toBe(sku);
        owners.set(key, sku);
        expect(names.has(key), `${sku}: "${synonym}" equals a product name`).toBe(false);
      }
    }
  });

  test('every name and every synonym, written alone, names exactly its own product (longest match)', () => {
    for (const product of activeAfter) {
      expect([...productRefsMentionedV31(catalog, product.name)], product.name).toEqual([`product:${product.sku}`]);
    }
    for (const { sku, synonyms } of synonymRows) {
      for (const synonym of synonyms) {
        expect([...productRefsMentionedV31(catalog, `quiero ${synonym} por favor`)], synonym).toEqual([`product:${sku}`]);
      }
    }
  });

  test('no new synonym sits inside another product name, and shared generic terms are never synonyms', () => {
    const overlaps = [];
    for (const { sku, synonyms } of synonymRows) {
      for (const synonym of synonyms) {
        for (const product of activeAfter.filter((candidate) => candidate.sku !== sku)) {
          if (!containsPhrase(product.name, synonym)) continue;
          // A 028 "muro" phrase inside a longer product name is allowed only
          // because that name, written alone, still names only its product.
          if (ownerAssigned028.has(fold(synonym))) {
            expect([...productRefsMentionedV31(catalog, product.name)], product.name).toEqual([`product:${product.sku}`]);
            continue;
          }
          overlaps.push(`${synonym} < ${product.name}`);
        }
      }
    }
    // The only other overlaps are the documented public 026 one and, since
    // 3c.27, the generic "baldosa" inside "Baldosa Minvu" (longest match keeps
    // "Baldosa Minvu" on its own product: see the name test above).
    expect(overlaps).toEqual(['placas de 50 < Placas de 50 cm Reforzadas', 'baldosa < Baldosa Minvu']);
    const folded = new Set(synonymRows.flatMap((row) => row.synonyms.map(fold)));
    for (const term of checks.shared_generic_terms || []) {
      if (ownerAssigned028.has(term)) continue;
      expect(folded.has(term), term).toBe(false);
    }
  });

  test('the private SQL files are generated and current', () => {
    expect(fs.readFileSync(DEFAULT_APPLY_PATH, 'utf8')).toBe(buildMigrationSql(data));
    expect(fs.readFileSync(rollbackPathFor(DEFAULT_APPLY_PATH), 'utf8')).toBe(buildRollbackSql(data));
    for (const delta of data.deltas || []) {
      expect(fs.readFileSync(deltaPathFor(DEFAULT_APPLY_PATH, delta), 'utf8'), delta.id).toBe(buildDeltaMigrationSql(data, delta.id));
      expect(fs.readFileSync(rollbackPathFor(deltaPathFor(DEFAULT_APPLY_PATH, delta)), 'utf8'), delta.id).toBe(buildDeltaRollbackSql(data, delta.id));
    }
  });

  // Task 3c.27: a split moves sheet content between the products of one delta
  // without losing or inventing any variant, unconfirmed entry or source file.
  // Task 3c.28: a later delta may touch the same skus, so the sheets a delta
  // writes come from deltaSteps, not from the final data.
  const deltas = data.deltas || [];
  const isSplit = (delta) => deltaSteps(data, delta.id).some((step) => step.role === 'create');
  test('every split delta redistributes the previous sheets exactly', () => {
    for (const delta of deltas.filter(isSplit)) {
      const previous = Object.values(delta.previous_technical_sheets);
      const now = deltaSteps(data, delta.id).map((step) => step.technical_sheet);
      const variantKeys = (sheets) => sheets.flatMap((sheet) => sheet.variants.map((variant) => JSON.stringify(variant))).sort();
      expect(variantKeys(now), delta.id).toEqual(variantKeys(previous));
      const unconfirmed = (sheets) => sheets.flatMap((sheet) => Object.entries(sheet.unconfirmed).map((entry) => JSON.stringify(entry))).sort();
      expect(unconfirmed(now), delta.id).toEqual(unconfirmed(previous));
      const files = (sheets) => sheets.flatMap((sheet) => sheet.source_files).sort();
      expect([...new Set(files(now))], delta.id).toEqual([...new Set(files(previous))]);
      // Each variant lives in exactly one product of the delta.
      expect(new Set(variantKeys(now)).size, delta.id).toBe(variantKeys(now).length);
    }
  });

  // Task 3c.28: a delta that creates nothing (the general_specs audit) only moves
  // facts from general_specs or the description into the variants that state
  // them: every variant keeps its name, order and fields, its `other` only grows,
  // source files stay as they were and unconfirmed entries are only added. A
  // variant field may be emptied only when its value moves into a new
  // unconfirmed entry (two sheets disagree on the same variant).
  test('every non-split delta keeps each variant and only adds to its other', () => {
    for (const delta of deltas.filter((candidate) => !isSplit(candidate))) {
      for (const { sku, technical_sheet: now } of deltaSteps(data, delta.id)) {
        const before = delta.previous_technical_sheets[sku];
        const where = `${delta.id} ${sku}`;
        for (const [label, values] of Object.entries(before.unconfirmed)) expect(now.unconfirmed[label], `${where} ${label}`).toEqual(values);
        const added = Object.entries(now.unconfirmed).filter(([label]) => !(label in before.unconfirmed)).flatMap(([, values]) => values);
        expect(now.source_files, where).toEqual(before.source_files);
        expect(now.variants.map((variant) => variant.name), where).toEqual(before.variants.map((variant) => variant.name));
        now.variants.forEach((variant, index) => {
          const { other, ...fields } = variant;
          const { other: otherBefore, ...fieldsBefore } = before.variants[index];
          for (const [key, value] of Object.entries(fieldsBefore)) {
            if (value !== null && fields[key] === null) {
              expect(added.some((entry) => entry.startsWith(`${value} `)), `${where} ${variant.name} ${key} -> unconfirmed`).toBe(true);
            } else {
              expect(fields[key], `${where} ${variant.name} ${key}`).toEqual(value);
            }
          }
          for (const [key, value] of Object.entries(otherBefore)) expect(other[key], `${where} ${variant.name} ${key}`).toEqual(value);
        });
      }
    }
  });

  test('the three largest sheets named in one turn stay within the 6144-byte cap', () => {
    const entries = items.map((item) => {
      const concept = item.item_type === 'service' || !activeAfter.some((product) => product.sku === item.sku) ? 'service' : 'product';
      return { ref: `${concept}:${item.sku}`, concept, value: item.name || item.sku, technical_sheet: item.technical_sheet };
    });
    const largest = [...entries].sort((a, b) => JSON.stringify(b.technical_sheet).length - JSON.stringify(a.technical_sheet).length).slice(0, 3);
    const input = buildV3PolicyInput({
      inbound_event_id: 'private-cap', conversation_id: 'private-cap', external_message_id: 'private-cap',
      text_body: `Cotizo ${largest.map((entry) => entry.value).join(', ')}`, qualification_context: {}, v3_grounding: { catalog: entries },
    }, { version: 'v3.1' });
    const sheets = input.grounding.catalog.map((entry) => entry.technical_sheet).filter(Boolean);
    expect(sheets).toHaveLength(3);
    expect(sheets.reduce((total, sheet) => total + Buffer.byteLength(JSON.stringify(sheet), 'utf8'), 0)).toBeLessThanOrEqual(6144);
    expect(JSON.stringify(sheets)).not.toContain('source_files');
  });
});
