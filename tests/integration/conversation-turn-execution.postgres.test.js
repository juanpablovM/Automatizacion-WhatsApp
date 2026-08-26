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
const query = (name) => fs.readFileSync(
  `db/queries/n8n/wa-conversation-orchestrator/${name}.sql`,
  'utf8',
);

describeIntegration('v3 conversation turn execution saga', () => {
  const client = new pg.Client(connection);
  const routeSql = query('07_route_v3_turn');
  let sourceNumberId;
  let activeStatusId;
  let sequence = 0;

  const cleanupFixtureNamespace = async () => {
    const sourceFilter = `
      SELECT id FROM whatsapp_numbers
      WHERE instance_name = 'v3-test'
         OR phone_number = '15550009999'
         OR phone_number_id = 'pn-v3-saga'
    `;
    await client.query(`
      BEGIN;
      DELETE FROM external_operations operation
      USING conversation_turn_executions execution, conversations conversation
      WHERE operation.entity_type = 'conversation_turn_execution'
        AND operation.entity_id = execution.id
        AND execution.conversation_id = conversation.id
        AND conversation.source_number_id IN (${sourceFilter});
      DELETE FROM audit_logs audit
      USING conversation_turn_executions execution, conversations conversation
      WHERE audit.entity_type = 'conversation_turn_execution'
        AND audit.entity_id = execution.id
        AND execution.conversation_id = conversation.id
        AND conversation.source_number_id IN (${sourceFilter});
      DELETE FROM conversation_turn_executions execution
      USING conversations conversation
      WHERE execution.conversation_id = conversation.id
        AND conversation.source_number_id IN (${sourceFilter});
      DELETE FROM advisor_decisions decision
      USING conversations conversation
      WHERE decision.conversation_id = conversation.id
        AND conversation.source_number_id IN (${sourceFilter});
      DELETE FROM inbound_events event
      WHERE event.instance_name = 'v3-test'
         OR event.source_number_id IN (${sourceFilter});
      DELETE FROM conversations conversation
      WHERE conversation.source_number_id IN (${sourceFilter});
      DELETE FROM whatsapp_numbers number
      WHERE number.id IN (${sourceFilter});
      COMMIT;
    `);
  };

  const seedEvent = async (conversationId, suffix, processingStatus = 'processing') => {
    const token = `token-${suffix}`;
    const { rows } = await client.query(`
      INSERT INTO inbound_events (
        instance_name, external_message_id, event_fingerprint, dedupe_key,
        source_number_id, phone_number, queue_key, event_type, normalized_event,
        should_process, processing_status, processing_token, processing_phase
      )
      SELECT 'v3-test', $2, $2, $2, $3::bigint, phone_number, $3::bigint::text || ':' || phone_number,
             'messages.upsert', 'message', TRUE, $5, $4, 'orchestrating'
      FROM conversations WHERE id = $1
      RETURNING id
    `, [conversationId, `event-${suffix}`, sourceNumberId, token, processingStatus]);
    return { inboundEventId: rows[0].id, token };
  };

  const seedConversation = async (qualification = { city: 'Santiago' }) => {
    sequence += 1;
    const { rows } = await client.query(`
      INSERT INTO conversations (
        source_number_id, phone_number, conversation_status_id,
        current_step, qualification_context
      ) VALUES ($1, $2, $3, 'qualification', $4::jsonb)
      RETURNING id, qualification_context
    `, [sourceNumberId, `15559${String(sequence).padStart(6, '0')}`, activeStatusId, qualification]);
    return rows[0];
  };

  beforeAll(async () => {
    await client.connect();
    await cleanupFixtureNamespace();
    const source = await client.query(`
      INSERT INTO whatsapp_numbers (
        display_name, phone_number, phone_number_id, instance_name, is_active
      ) VALUES ('v3 saga tests', '15550009999', 'pn-v3-saga', 'v3-test', TRUE)
      RETURNING id
    `);
    sourceNumberId = source.rows[0].id;
    const status = await client.query(
      "SELECT id FROM conversation_statuses WHERE code = 'active'",
    );
    activeStatusId = status.rows[0].id;
  });

  afterAll(async () => {
    await cleanupFixtureNamespace();
    await client.end();
  });

  test('serializes different active turns for one conversation', async () => {
    const conversation = await seedConversation();
    const first = await seedEvent(conversation.id, `serial-a-${sequence}`);
    const second = await seedEvent(conversation.id, `serial-b-${sequence}`, 'received');
    const other = new pg.Client(connection);
    await other.connect();
    try {
      const [a, b] = await Promise.all([
        client.query(routeSql, [first.inboundEventId, conversation.id, 'enforce', 'serial', 1, 'snap-a', conversation.qualification_context]),
        other.query(routeSql, [second.inboundEventId, conversation.id, 'enforce', 'serial', 1, 'snap-b', conversation.qualification_context]),
      ]);
      expect(a.rows.length + b.rows.length).toBe(1);
      const activeEvent = (a.rows[0] || b.rows[0]).inbound_event_id;
      await client.query(
        "UPDATE conversation_turn_executions SET state = 'aborted' WHERE inbound_event_id = $1",
        [activeEvent],
      );
      const waiting = activeEvent === String(first.inboundEventId) ? second : first;
      const retried = await client.query(routeSql, [
        waiting.inboundEventId, conversation.id, 'enforce', 'serial', 1,
        activeEvent === String(first.inboundEventId) ? 'snap-b' : 'snap-a',
        conversation.qualification_context,
      ]);
      expect(retried.rows[0].route_acquired).toBe(true);
    } finally {
      await other.end();
    }
  });
});
