// =============================================================================
// Migration 042: no inbound debounce while a seller owns the chat. Static
// checks of the migration and its rollback; the behavior is covered by
// tests/integration/inbound-debounce-seller-owned.postgres.test.js.
// =============================================================================
import fs from 'node:fs';
import { describe, expect, test } from 'vitest';

const read = (file) => fs.readFileSync(file, 'utf8');
const migration034 = read('infra/postgres/migrations/034_inbound_debounce_batches.sql');
const migration = read('infra/postgres/migrations/042_no_debounce_for_seller_owned_chats.sql');
const rollback = read('infra/postgres/rollback/042_no_debounce_for_seller_owned_chats.down.sql');

// The full `CREATE FUNCTION <name>(<first argument>...` statement up to its
// closing `$$;`.
const functionStatement = (sql, header) => {
  const start = sql.indexOf(header);
  if (start < 0) throw new Error(`missing ${header}`);
  const bodyStart = sql.indexOf('AS $$', start);
  const end = sql.indexOf('$$;', bodyStart + 'AS $$'.length);
  return sql.slice(start, end + '$$;'.length);
};

const executable = (sql) => sql.replace(/^\s*--.*$/gm, '').trim();

describe('migration 042 no debounce for seller-owned chats', () => {
  test('is one atomic transaction with a bounded lock wait', () => {
    expect(executable(migration)).toMatch(/^BEGIN;\s*SET LOCAL lock_timeout = '5s';/);
    expect(executable(migration)).toMatch(/COMMIT;$/);
  });

  test('keeps the ownership predicate in one function used by both claims', () => {
    expect(migration).toMatch(/CREATE OR REPLACE FUNCTION inbound_contact_seller_owned\(/);
    const claim = functionStatement(migration, 'CREATE OR REPLACE FUNCTION claim_inbound_event(p_payload JSONB)');
    const recover = functionStatement(migration, 'CREATE OR REPLACE FUNCTION recover_and_claim_inbound_events(\n  p_stale_seconds INTEGER,\n  p_batch_size INTEGER,\n  p_max_attempts INTEGER,\n  p_debounce_seconds');
    expect(claim).toContain('inbound_contact_seller_owned(');
    expect(recover).toContain('inbound_contact_seller_owned(');
    for (const statement of [claim, recover]) {
      expect(statement).not.toMatch(/lead_chat_ownerships/);
    }
  });

  test('changes only the seller-owned window of the 034 claims', () => {
    const claim034 = functionStatement(migration034, 'CREATE FUNCTION claim_inbound_event(p_payload JSONB)');
    const claim042 = functionStatement(migration, 'CREATE OR REPLACE FUNCTION claim_inbound_event(p_payload JSONB)');
    // Same signature and result columns: CREATE OR REPLACE keeps dependants.
    const signature = (statement) => statement.slice(statement.indexOf('RETURNS TABLE'), statement.indexOf('LANGUAGE'));
    expect(signature(claim042)).toBe(signature(claim034));
  });
});

describe('rollback 042', () => {
  test('is one atomic transaction with a bounded lock wait', () => {
    expect(executable(rollback)).toMatch(/^BEGIN;\s*SET LOCAL lock_timeout = '5s';/);
    expect(executable(rollback)).toMatch(/COMMIT;$/);
  });

  test('restores the exact 034 claim_inbound_event definition', () => {
    const original = functionStatement(migration034, 'CREATE FUNCTION claim_inbound_event(p_payload JSONB)');
    const restored = functionStatement(rollback, 'CREATE OR REPLACE FUNCTION claim_inbound_event(p_payload JSONB)');
    expect(restored).toBe(original.replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION'));
  });

  test('restores the exact 034 six-argument recover_and_claim_inbound_events definition', () => {
    const header = 'FUNCTION recover_and_claim_inbound_events(\n  p_stale_seconds INTEGER,\n  p_batch_size INTEGER,\n  p_max_attempts INTEGER,\n  p_debounce_seconds';
    const original = functionStatement(migration034, `CREATE ${header}`);
    const restored = functionStatement(rollback, `CREATE OR REPLACE ${header}`);
    expect(restored).toBe(original.replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION'));
  });

  test('drops the ownership helper after the claims stop calling it', () => {
    const drop = rollback.indexOf('DROP FUNCTION IF EXISTS inbound_contact_seller_owned(BIGINT, TEXT);');
    expect(drop).toBeGreaterThan(rollback.lastIndexOf('CREATE OR REPLACE FUNCTION'));
  });
});
