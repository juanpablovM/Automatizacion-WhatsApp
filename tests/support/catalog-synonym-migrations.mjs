// Live public synonym lists per sku, as the public data migrations leave them:
// 026 writes one list per product, 028 appends the "muro" phrases to
// cierros-hormigon (task 3c.21), and 029 moves the generic "baldosa" phrases
// off baldosa-minvu and appends its tactile phrases (task 3c.27).
import fs from 'node:fs';

export const MIGRATION_026_PATH = 'infra/postgres/migrations/026_catalog_product_synonyms.sql';
export const MIGRATION_028_PATH = 'infra/postgres/migrations/028_cierros_muro_synonyms.sql';
export const MIGRATION_029_PATH = 'infra/postgres/migrations/029_baldosa_minvu_synonyms.sql';

export const fold = (value) => String(value).normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLocaleLowerCase('es').replace(/\s+/g, ' ').trim();

// ('sku', '[...]'::jsonb) rows of 026 and 028.
export const parseSynonymRows = (sql) => [...sql.matchAll(/\(\s*'([a-z0-9-]+)',\s*'(\[[^']*\])'::jsonb\s*\)/g)]
  .map(([, sku, json]) => ({ sku, synonyms: JSON.parse(json) }));

// ('sku', '[removed]'::jsonb, '[added]'::jsonb) rows of 029.
export const parseMoveRows = (sql) => [...sql.matchAll(/\(\s*'([a-z0-9-]+)',\s*'(\[[^']*\])'::jsonb,\s*'(\[[^']*\])'::jsonb\s*\)/g)]
  .map(([, sku, removed, added]) => ({ sku, removed: JSON.parse(removed), added: JSON.parse(added) }));

export const rows026 = () => parseSynonymRows(fs.readFileSync(MIGRATION_026_PATH, 'utf8'));
export const rows028 = () => parseSynonymRows(fs.readFileSync(MIGRATION_028_PATH, 'utf8'));
export const rows029 = () => parseMoveRows(fs.readFileSync(MIGRATION_029_PATH, 'utf8'));

// Applies 029 the way its SQL does: drop the removed phrases (exact text), then
// append the added ones that are not already there, in order.
export const applyMoves = (bySku, moves) => {
  const result = new Map(bySku);
  for (const { sku, removed, added } of moves) {
    const kept = (result.get(sku) || []).filter((phrase) => !removed.includes(phrase));
    result.set(sku, [...kept, ...added.filter((phrase) => !kept.includes(phrase))]);
  }
  return result;
};

// One { sku, synonyms } row per sku, in 026 order, after 026, 028 and 029.
export const livePublicSynonymRows = () => {
  let bySku = new Map();
  for (const { sku, synonyms } of [...rows026(), ...rows028()]) bySku.set(sku, [...(bySku.get(sku) || []), ...synonyms]);
  bySku = applyMoves(bySku, rows029());
  return [...bySku].map(([sku, synonyms]) => ({ sku, synonyms }));
};
