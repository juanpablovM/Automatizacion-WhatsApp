// Task 3c.21: migration 028 appends the "muro" phrases to cierros-hormigon's
// catalog_items.metadata.synonyms after the 026 list, keeps every other key and
// synonym, touches no other product, is idempotent, and its rollback removes
// exactly those phrases.
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
const migrationSql = fs.readFileSync('infra/postgres/migrations/028_cierros_muro_synonyms.sql', 'utf8');
const rollbackSql = fs.readFileSync('infra/postgres/rollback/028_cierros_muro_synonyms.down.sql', 'utf8');
const MURO_SYNONYMS = JSON.parse(/'cierros-hormigon',\s*'(\[[^']*\])'::jsonb/.exec(migrationSql)[1]);
const SYNONYMS_026 = ['cierro de hormigón', 'cierros de concreto', 'cierro de concreto', 'cierre de hormigón', 'cierro prefabricado'];

describeIntegration('028_cierros_muro_synonyms', () => {
  const client = new pg.Client(connection);

  beforeAll(async () => {
    await client.connect();
    await client.query('BEGIN');
    await client.query('DELETE FROM catalog_items WHERE sku = ANY($1::text[])', [['cierros-hormigon', 'bloques-hormigon']]);
    await client.query(
      `INSERT INTO catalog_items (sku, name, item_type, metadata)
       VALUES ('cierros-hormigon', 'Cierros de Hormigón', 'product',
               jsonb_build_object('url', 'https://example.test/cierros', 'synonyms', $1::jsonb))`,
      [JSON.stringify(SYNONYMS_026)],
    );
    await client.query(
      `INSERT INTO catalog_items (sku, name, item_type, metadata)
       VALUES ('bloques-hormigon', 'Bloques de Hormigón', 'product', '{"synonyms": ["bloques de cemento"]}'::jsonb)`,
    );
  });

  afterAll(async () => {
    if (enabled) {
      await client.query('ROLLBACK');
      await client.end();
    }
  });

  const metadataOf = async (sku) => (await client.query('SELECT metadata FROM catalog_items WHERE sku = $1', [sku])).rows[0].metadata;

  test('appends the muro phrases after the 026 list and keeps the other keys', async () => {
    const result = await client.query(migrationSql);
    expect(result.rowCount).toBe(1);

    expect(await metadataOf('cierros-hormigon')).toEqual({
      url: 'https://example.test/cierros', synonyms: [...SYNONYMS_026, ...MURO_SYNONYMS],
    });
    expect(await metadataOf('bloques-hormigon')).toEqual({ synonyms: ['bloques de cemento'] });
  });

  test('is idempotent: a second run touches no row', async () => {
    const result = await client.query(migrationSql);
    expect(result.rowCount).toBe(0);
  });

  test('appends only what is missing when part of the list is already there', async () => {
    await client.query(
      `UPDATE catalog_items SET metadata = jsonb_set(metadata, '{synonyms}', $1::jsonb) WHERE sku = 'cierros-hormigon'`,
      [JSON.stringify([...SYNONYMS_026, MURO_SYNONYMS[2]])],
    );
    const result = await client.query(migrationSql);
    expect(result.rowCount).toBe(1);
    expect((await metadataOf('cierros-hormigon')).synonyms)
      .toEqual([...SYNONYMS_026, MURO_SYNONYMS[2], ...MURO_SYNONYMS.filter((_, index) => index !== 2)]);
  });

  test('the rollback removes exactly the muro phrases and keeps the 026 list', async () => {
    const result = await client.query(rollbackSql);
    expect(result.rowCount).toBe(1);
    expect(await metadataOf('cierros-hormigon')).toEqual({ url: 'https://example.test/cierros', synonyms: SYNONYMS_026 });
    expect(await metadataOf('bloques-hormigon')).toEqual({ synonyms: ['bloques de cemento'] });
    expect((await client.query(rollbackSql)).rowCount).toBe(0);
  });

  test('on a row without 026 synonyms, apply then rollback leaves no synonyms key', async () => {
    await client.query("UPDATE catalog_items SET metadata = '{\"url\": \"https://example.test/cierros\"}'::jsonb WHERE sku = 'cierros-hormigon'");
    expect((await client.query(migrationSql)).rowCount).toBe(1);
    expect((await metadataOf('cierros-hormigon')).synonyms).toEqual(MURO_SYNONYMS);
    expect((await client.query(rollbackSql)).rowCount).toBe(1);
    expect(await metadataOf('cierros-hormigon')).toEqual({ url: 'https://example.test/cierros' });
  });
});
