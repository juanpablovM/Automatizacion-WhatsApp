// Task 3c.19: migration 026 writes catalog_items.metadata.synonyms for the 24
// active products, keyed by sku, without touching any other metadata key; it
// is idempotent, and its rollback removes only the `synonyms` key.
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
const migrationSql = fs.readFileSync('infra/postgres/migrations/026_catalog_product_synonyms.sql', 'utf8');
const rollbackSql = fs.readFileSync('infra/postgres/rollback/026_catalog_product_synonyms.down.sql', 'utf8');
const captured = JSON.parse(fs.readFileSync('tests/fixtures/v3-line-items/captured-distributive-ambiguous.json', 'utf8'));
const PRODUCTS = captured.policy.grounding.catalog
  .filter((entry) => entry.concept === 'product')
  .map((entry) => ({ sku: entry.ref.slice('product:'.length), name: entry.value }));

describeIntegration('026_catalog_product_synonyms', () => {
  const client = new pg.Client(connection);

  beforeAll(async () => {
    await client.connect();
    await client.query('BEGIN');
    await client.query('DELETE FROM catalog_items WHERE sku = ANY($1::text[]) OR sku = $2',
      [PRODUCTS.map((product) => product.sku), 'adocesped']);
    for (const product of PRODUCTS) {
      await client.query(
        `INSERT INTO catalog_items (sku, name, item_type, metadata)
         VALUES ($1, $2, 'product', jsonb_build_object('url', 'https://example.test/' || $1::text))`,
        [product.sku, product.name],
      );
    }
    // A product outside the list must never be touched.
    await client.query(
      `INSERT INTO catalog_items (sku, name, item_type, metadata)
       VALUES ('adocesped', 'Adocesped', 'product', '{"url": "https://example.test/adocesped"}'::jsonb)`,
    );
  });

  afterAll(async () => {
    if (enabled) {
      await client.query('ROLLBACK');
      await client.end();
    }
  });

  const metadataBySku = async () => {
    const { rows } = await client.query('SELECT sku, metadata, updated_at FROM catalog_items WHERE sku = ANY($1::text[])',
      [[...PRODUCTS.map((product) => product.sku), 'adocesped']]);
    return new Map(rows.map((row) => [row.sku, row]));
  };

  test('writes a synonyms array on every listed product and keeps the other keys', async () => {
    const result = await client.query(migrationSql);
    expect(result.rowCount).toBe(24);

    const rows = await metadataBySku();
    for (const product of PRODUCTS) {
      const { metadata } = rows.get(product.sku);
      expect(metadata.url, product.sku).toBe(`https://example.test/${product.sku}`);
      expect(Array.isArray(metadata.synonyms), product.sku).toBe(true);
      expect(metadata.synonyms.length, product.sku).toBeGreaterThan(0);
    }
    expect(rows.get('bloques-hormigon').metadata.synonyms).toContain('bloques de cemento');
    expect(rows.get('adocesped').metadata).toEqual({ url: 'https://example.test/adocesped' });
  });

  test('is idempotent: a second run touches no row', async () => {
    const result = await client.query(migrationSql);
    expect(result.rowCount).toBe(0);
  });

  test('the rollback removes only the synonyms key', async () => {
    const result = await client.query(rollbackSql);
    expect(result.rowCount).toBe(24);

    const rows = await metadataBySku();
    for (const product of PRODUCTS) {
      expect(rows.get(product.sku).metadata, product.sku).toEqual({ url: `https://example.test/${product.sku}` });
    }
    expect(rows.get('adocesped').metadata).toEqual({ url: 'https://example.test/adocesped' });
  });
});
