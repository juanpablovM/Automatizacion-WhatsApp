// The SQL twin of the JS reducer (`apply_v3_state_mutations`, defined in
// infra/postgres/migrations/025_item_aware_v3_state_mutations.sql) must
// produce byte-identical results to `reduceV3StateMutations`
// (tests/fixtures/workflow-nodes/shared/v3-line-items.js) on the same shared
// case table, because `Build V3 Lead Effect` composes the lead from
// `qualification_context` plus the projected mutations *before*
// `09_commit_v3_turn.sql` persists them through the SQL function — the two
// reducers have to exist twice, and they have to agree.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const { reduceV3StateMutations } = require('../fixtures/workflow-nodes/shared/v3-line-items.js');
const { LINE_ITEM_REDUCER_CASES } = require('../fixtures/workflow-nodes/shared/v3-line-items.cases.js');

const enabled = process.env.TEST_PG_INTEGRATION === '1';
const describeIntegration = enabled ? describe : describe.skip;
const connection = {
  host: process.env.TEST_PGHOST || '127.0.0.1',
  port: Number(process.env.TEST_PGPORT || 55433),
  database: process.env.TEST_PGDATABASE || 'testdb',
  user: process.env.TEST_PGUSER || 'test',
  password: process.env.TEST_PGPASSWORD || 'test',
};

const applyMutations = (client, context, mutations) => client.query(
  'SELECT apply_v3_state_mutations($1::jsonb, $2::jsonb) AS result',
  [JSON.stringify(context ?? {}), JSON.stringify(mutations ?? [])],
);

describeIntegration('v3 item-aware state mutation SQL/JS parity', () => {
  const client = new pg.Client(connection);

  beforeAll(async () => {
    await client.connect();
  });

  afterAll(async () => {
    if (enabled) await client.end();
  });

  for (const testCase of LINE_ITEM_REDUCER_CASES) {
    test(`SQL matches the JS reducer: ${testCase.name}`, async () => {
      if (testCase.expectedError) {
        await expect(applyMutations(client, testCase.context, testCase.mutations))
          .rejects.toThrow(new RegExp(testCase.expectedError));
        expect(() => reduceV3StateMutations(testCase.context, testCase.mutations))
          .toThrow(new RegExp(testCase.expectedError));
        return;
      }

      const sqlResult = await applyMutations(client, testCase.context, testCase.mutations);
      const jsResult = reduceV3StateMutations(testCase.context, testCase.mutations);

      expect(sqlResult.rows[0].result).toEqual(testCase.expectedContext);
      expect(sqlResult.rows[0].result).toEqual(jsResult);
    });
  }

  test('replaying a committed turn is idempotent: no duplicate item, stable projection', async () => {
    const mutations = [
      { operation: 'set', field: 'product', projected_value: 'Bloques de Hormigón' },
      { operation: 'set', field: 'quantity', projected_value: 100 },
    ];

    const first = await applyMutations(client, {}, mutations);
    const replay = await applyMutations(client, first.rows[0].result, mutations);

    expect(replay.rows[0].result.line_items).toHaveLength(1);
    expect(replay.rows[0].result).toEqual(first.rows[0].result);
    expect(replay.rows[0].result).toEqual(reduceV3StateMutations(first.rows[0].result, mutations));
  });

  test('applying the down migration restores the 022 flat-only behavior', async () => {
    const downgrade = new pg.Client(connection);
    await downgrade.connect();
    try {
      await downgrade.query('BEGIN');
      await downgrade.query(fs.readFileSync(
        'infra/postgres/rollback/025_item_aware_v3_state_mutations.down.sql',
        'utf8',
      ));

      const restored = await applyMutations(downgrade, {}, [
        { operation: 'set', field: 'product', projected_value: 'X' },
        { operation: 'set', field: 'quantity', projected_value: 5 },
      ]);

      // The 022 body never introduces line_items scaffolding: it always
      // writes the mutated fields flat, even when they are item concepts.
      expect(restored.rows[0].result).toEqual({ product: 'X', quantity: 5 });
    } finally {
      // Never committed: other connections (and later tests in this suite)
      // must keep seeing the item-aware 025 function.
      await downgrade.query('ROLLBACK');
      await downgrade.end();
    }
  });
});
