// Task 3c.26: conversation 387 (2026-09-30) removed its only item after "No
// quiero baldosas minvu", and the next turn set Baldosa Minvu again. The
// removal is durable evidence in the committed turn ledger: the decision's
// remove_item mutation names the item, and the turn's state receipt holds the
// item (with its product) as it was before the commit. `Load Conversation
// State` lists those products in `v3_grounding.removed_products`, only when
// there is at least one, so every other grounding keeps its exact shape.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const { buildV3PolicyInput } = require('../fixtures/workflow-nodes/shared/v3-rollout-runtime.js');
const { compileV3TurnPolicy } = require('../fixtures/workflow-nodes/shared/v3-contract-runtime.js');

const enabled = process.env.TEST_PG_INTEGRATION === '1';
const describeIntegration = enabled ? describe : describe.skip;
const connection = {
  host: process.env.TEST_PGHOST || '127.0.0.1',
  port: Number(process.env.TEST_PGPORT || 55433),
  database: process.env.TEST_PGDATABASE || 'testdb',
  user: process.env.TEST_PGUSER || 'test',
  password: process.env.TEST_PGPASSWORD || 'test',
};
const loadSql = fs.readFileSync('db/queries/n8n/wa-conversation-orchestrator/01_load_active_context.sql', 'utf8');

const PHONE = '15550008777';
const item = (itemId, product) => ({
  item_id: itemId, product, quantity: null, measurements: null, catalog_ref: null, requested_label: null,
});
const lineItemsContext = (items) => ({
  line_items: items,
  line_items_schema: 'line_items/v1',
  product: items[0]?.product ?? null,
  quantity: null,
  measurements: null,
  line_items_projection: { product: items[0]?.product ?? null, quantity: null, measurements: null },
});

describeIntegration('Load Conversation State lists the products the customer removed', () => {
  const client = new pg.Client(connection);
  let sourceNumberId;
  let conversationId;
  let sequence = 0;

  const seedEvent = async (status = 'processed', token = null) => {
    sequence += 1;
    const { rows } = await client.query(`
      INSERT INTO inbound_events (
        source_number_id, phone_number, external_message_id, instance_name,
        event_fingerprint, dedupe_key, queue_key, event_type,
        raw_payload, processing_status, processing_token
      ) VALUES ($1, $2, $3, 'removed-instance', $3, $3, $2, 'messages.upsert', '{}'::jsonb, $4, $5)
      RETURNING id
    `, [sourceNumberId, PHONE, `removed-msg-${sequence}`, status, token]);
    return rows[0].id;
  };

  const seedCommittedTurn = async ({ mutations, stateBefore, committed = true }) => {
    const eventId = await seedEvent();
    const decision = await client.query(`
      INSERT INTO advisor_decisions (conversation_id, decision_type, output_payload, validation_result)
      VALUES ($1, 'conversation_v3_authorized', $2::jsonb, 'accepted') RETURNING id
    `, [conversationId, {
      version: 'validated_conversation_decision/v3.1',
      decision_id: `removed-decision-${sequence}`,
      state_mutations: mutations,
    }]);
    await client.query(`
      INSERT INTO conversation_turn_executions (
        inbound_event_id, conversation_id, advisor_decision_id, decision_id, contract_version,
        route_mode, route_rule_id, state, state_receipt
      ) VALUES ($1, $2, $3, $4, 'v3', 'enforce', 'removed-products-test', $5, $6::jsonb)
    `, [eventId, conversationId, decision.rows[0].id, `removed-decision-${sequence}`,
      committed ? 'delivered' : 'aborted',
      committed ? { schema: 'conversation_state_receipt/v3', state_before: stateBefore, state_after: {} } : null]);
  };

  const loadRow = async () => {
    const token = `removed-token-${sequence + 1}`;
    const eventId = await seedEvent('processing', token);
    const { rows } = await client.query(loadSql, [
      PHONE, String(sourceNumberId), 'Cliente', '', `removed-msg-${sequence}`, '',
      'text', 'Baldosas', '{}', '', '', '', '', '', '', '',
      'removed-instance', String(eventId), token,
    ]);
    // Only one event per contact may be processing at a time.
    await client.query("UPDATE inbound_events SET processing_status = 'processed' WHERE id = $1", [eventId]);
    return rows[0];
  };

  beforeAll(async () => {
    await client.connect();
    await client.query('BEGIN');
    const number = await client.query(
      `INSERT INTO whatsapp_numbers (phone_number_id, instance_name, display_name, phone_number, is_active)
       VALUES ('synthetic-removed', 'removed-instance', 'Removed', $1, TRUE) RETURNING id`,
      [PHONE],
    );
    sourceNumberId = number.rows[0].id;
    await client.query(
      `INSERT INTO catalog_items (sku, name, item_type, applicable_cities, is_active, metadata)
       VALUES ('baldosa-minvu', 'Baldosa Minvu', 'product', ARRAY['Santiago'], TRUE, '{"synonyms": ["baldosas", "baldosa"]}'::jsonb),
              ('pastelones', 'Pastelones', 'product', ARRAY['Santiago'], TRUE, '{}'::jsonb)`,
    );
    const status = await client.query("SELECT id FROM conversation_statuses WHERE code = 'waiting_user'");
    const conversation = await client.query(`
      INSERT INTO conversations (source_number_id, phone_number, conversation_status_id, current_step, qualification_context)
      VALUES ($1, $2, $3, 'product', '{}'::jsonb) RETURNING id
    `, [sourceNumberId, PHONE, status.rows[0].id]);
    conversationId = conversation.rows[0].id;
  });

  afterAll(async () => {
    if (enabled) {
      await client.query('ROLLBACK');
      await client.end();
    }
  });

  test('a conversation without removals keeps the exact grounding shape', async () => {
    const row = await loadRow();
    expect(Object.keys(row.v3_grounding)).toEqual(['catalog']);
  });

  test('a committed remove_item lists the removed product once', async () => {
    await seedCommittedTurn({
      mutations: [{ operation: 'set', field: 'product', item_id: 'li_a', projected_value: 'Baldosa Minvu' }],
      stateBefore: {},
    });
    await seedCommittedTurn({
      mutations: [{ operation: 'remove_item', field: null, item_id: 'li_a', projected_value: null }],
      stateBefore: lineItemsContext([item('li_a', 'Baldosa Minvu'), item('li_b', 'Pastelones')]),
    });
    // An aborted turn never changed the conversation and proves nothing.
    await seedCommittedTurn({
      mutations: [{ operation: 'remove_item', field: null, item_id: 'li_b', projected_value: null }],
      stateBefore: lineItemsContext([item('li_b', 'Pastelones')]),
      committed: false,
    });
    const row = await loadRow();
    expect(row.v3_grounding.removed_products).toEqual(['Baldosa Minvu']);

    const v31 = compileV3TurnPolicy(buildV3PolicyInput(row, { version: 'v3.1' }));
    expect(v31.grounding.catalog.find((entry) => entry.ref === 'product:baldosa-minvu'))
      .toMatchObject({ value: 'Baldosa Minvu', removed_by_customer: true });
    expect(v31.grounding.catalog.find((entry) => entry.ref === 'product:pastelones')).not.toHaveProperty('removed_by_customer');
    const v3 = compileV3TurnPolicy(buildV3PolicyInput(row));
    expect(v3.grounding.catalog.find((entry) => entry.ref === 'product:baldosa-minvu')).toEqual({
      ref: 'product:baldosa-minvu', concept: 'product', value: 'Baldosa Minvu',
    });
  });

  test('a removal before a conversation reset no longer counts', async () => {
    await client.query(`
      INSERT INTO audit_logs (event_name, entity_type, entity_id, actor_type, actor_id, result, metadata, created_at)
      VALUES ('conversation_state_evaluated', 'conversation', $1, 'system', 'test', 'success',
              '{"reset_conversation_lead": true}'::jsonb, NOW() + INTERVAL '1 second')
    `, [conversationId]);
    const row = await loadRow();
    expect(Object.keys(row.v3_grounding)).toEqual(['catalog']);
  });
});
