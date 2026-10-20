// Task 3c.27: migration 029 removes "baldosa", "baldosas" and "baldosa de
// vereda" from baldosa-minvu's catalog_items.metadata.synonyms and appends the
// tactile phrases after the kept ones; it keeps every other key and synonym,
// touches no other product, is idempotent, and its rollback restores the exact
// 026 list (same phrases, same order).
import fs from 'node:fs';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

const enabled = process.env.TEST_PG_INTEGRATION === '1';
const describeIntegration = enabled ? describe : describe.skip;
const connection = {
  host: process.env.TEST_PGHOST || '127.0.0.1',
  port: Number(process.env.TEST_PGPORT || 55433),
  database: process.env.TEST_PGDATABASE || 'testdb',
  user: process.env.TEST_PGUSER || 'test',
  password: process.env.TEST_PGPASSWORD || 'test',
};
const migrationSql = fs.readFileSync('infra/postgres/migrations/029_baldosa_minvu_synonyms.sql', 'utf8');
const rollbackSql = fs.readFileSync('infra/postgres/rollback/029_baldosa_minvu_synonyms.down.sql', 'utf8');
const [, REMOVED, ADDED] = /'baldosa-minvu',\s*'(\[[^']*\])'::jsonb,\s*'(\[[^']*\])'::jsonb/.exec(migrationSql)
  .map((value, index) => (index === 0 ? value : JSON.parse(value)));
const SYNONYMS_026 = ['baldosas minvu', 'baldosa', 'baldosas', 'baldosa de vereda'];

describeIntegration('029_baldosa_minvu_synonyms', () => {
  const client = new pg.Client(connection);

  beforeAll(async () => {
    await client.connect();
    await client.query('BEGIN');
    await client.query('DELETE FROM catalog_items WHERE sku = ANY($1::text[])', [['baldosa-minvu', 'pastelones']]);
    await client.query(
      `INSERT INTO catalog_items (sku, name, item_type, metadata)
       VALUES ('baldosa-minvu', 'Baldosa Minvu', 'product',
               jsonb_build_object('url', 'https://example.test/baldosa', 'technical_sheet', '{"description": "x"}'::jsonb, 'synonyms', $1::jsonb))`,
      [JSON.stringify(SYNONYMS_026)],
    );
    await client.query(
      `INSERT INTO catalog_items (sku, name, item_type, metadata)
       VALUES ('pastelones', 'Pastelones', 'product', '{"synonyms": ["baldosa", "pastelón"]}'::jsonb)`,
    );
  });

  afterAll(async () => {
    if (enabled) {
      await client.query('ROLLBACK');
      await client.end();
    }
  });

  const metadataOf = async (sku) => (await client.query('SELECT metadata FROM catalog_items WHERE sku = $1', [sku])).rows[0].metadata;

  test('removes the generic phrases, appends the tactile ones and keeps the other keys', async () => {
    const result = await client.query(migrationSql);
    expect(result.rowCount).toBe(1);
    expect(await metadataOf('baldosa-minvu')).toEqual({
      url: 'https://example.test/baldosa', technical_sheet: { description: 'x' }, synonyms: ['baldosas minvu', ...ADDED],
    });
    // Another product is never touched, even when it holds one of the phrases.
    expect(await metadataOf('pastelones')).toEqual({ synonyms: ['baldosa', 'pastelón'] });
  });

  test('is idempotent: a second run touches no row', async () => {
    expect((await client.query(migrationSql)).rowCount).toBe(0);
  });

  test('a row that regained a removed phrase is cleaned again, without duplicates', async () => {
    await client.query(
      `UPDATE catalog_items SET metadata = jsonb_set(metadata, '{synonyms}', $1::jsonb) WHERE sku = 'baldosa-minvu'`,
      [JSON.stringify(['baldosas minvu', ADDED[1], 'baldosa'])],
    );
    expect((await client.query(migrationSql)).rowCount).toBe(1);
    expect((await metadataOf('baldosa-minvu')).synonyms)
      .toEqual(['baldosas minvu', ADDED[1], ...ADDED.filter((_, index) => index !== 1)]);
  });

  test('the rollback restores the exact 026 list and is idempotent', async () => {
    await client.query(
      `UPDATE catalog_items SET metadata = jsonb_set(metadata, '{synonyms}', $1::jsonb) WHERE sku = 'baldosa-minvu'`,
      [JSON.stringify(['baldosas minvu', ...ADDED])],
    );
    expect((await client.query(rollbackSql)).rowCount).toBe(1);
    expect(await metadataOf('baldosa-minvu')).toEqual({
      url: 'https://example.test/baldosa', technical_sheet: { description: 'x' }, synonyms: SYNONYMS_026,
    });
    expect(REMOVED).toEqual(SYNONYMS_026.slice(1));
    expect((await client.query(rollbackSql)).rowCount).toBe(0);
    expect(await metadataOf('pastelones')).toEqual({ synonyms: ['baldosa', 'pastelón'] });
  });

  test('apply then rollback on a row without synonyms leaves the 026 generic phrases', async () => {
    await client.query("UPDATE catalog_items SET metadata = '{\"url\": \"https://example.test/baldosa\"}'::jsonb WHERE sku = 'baldosa-minvu'");
    expect((await client.query(migrationSql)).rowCount).toBe(1);
    expect((await metadataOf('baldosa-minvu')).synonyms).toEqual(ADDED);
    expect((await client.query(rollbackSql)).rowCount).toBe(1);
    expect((await metadataOf('baldosa-minvu')).synonyms).toEqual(REMOVED);
  });
});
