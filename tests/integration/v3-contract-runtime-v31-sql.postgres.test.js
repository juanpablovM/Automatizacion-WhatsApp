// Slice 2a (design.md task 2a.25/2a.26), dark: 08/09/15/16_*.sql accept the
// v3.1 artifact version alongside the unchanged v3 one, and 09 persists the
// decision's own version instead of hardcoding v3. Nothing in production
// compiles v3.1 yet — this proves only the SQL boundary, mirroring the JS
// contract's version-dispatched acceptance (v3-contract-runtime.test.js).
import fs from 'node:fs';
import { createHash } from 'node:crypto';
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

describeIntegration('v3.1 SQL boundary accepts the item-aware artifact version (2a.25/2a.26)', () => {
  const client = new pg.Client(connection);
  const routeSql = query('07_route_v3_turn');
  const prepareSql = query('08_prepare_v3_decision');
  const commitSql = query('09_commit_v3_turn');
  const prepareContingencySql = query('15_prepare_v3_contingency');
  const persistAuthoritySql = query('16_persist_v3_turn_authority');

  let sourceNumberId;
  let activeStatusId;
  let sequence = 0;

  const cleanupFixtureNamespace = async () => {
    const sourceFilter = `
      SELECT id FROM whatsapp_numbers
      WHERE instance_name = 'v31-sql-test' OR phone_number_id = 'pn-v31-sql-saga'
    `;
    await client.query(`
      BEGIN;
      DELETE FROM conversation_turn_executions execution
      USING conversations conversation
      WHERE execution.conversation_id = conversation.id
        AND conversation.source_number_id IN (${sourceFilter});
      DELETE FROM advisor_decisions decision
      USING conversations conversation
      WHERE decision.conversation_id = conversation.id
        AND conversation.source_number_id IN (${sourceFilter});
      DELETE FROM inbound_events event WHERE event.instance_name = 'v31-sql-test';
      DELETE FROM conversations conversation
      WHERE conversation.source_number_id IN (${sourceFilter});
      DELETE FROM whatsapp_numbers number WHERE number.id IN (${sourceFilter});
      COMMIT;
    `);
  };

  beforeAll(async () => {
    await client.connect();
    await cleanupFixtureNamespace();
    const source = await client.query(`
      INSERT INTO whatsapp_numbers (
        display_name, phone_number, phone_number_id, instance_name, is_active
      ) VALUES ('v3.1 sql tests', '15550001111', 'pn-v31-sql-saga', 'v31-sql-test', TRUE)
      RETURNING id
    `);
    sourceNumberId = source.rows[0].id;
    const status = await client.query("SELECT id FROM conversation_statuses WHERE code = 'active'");
    activeStatusId = status.rows[0].id;
  });

  afterAll(async () => {
    await cleanupFixtureNamespace();
    await client.end();
  });

  const seedConversation = async () => {
    sequence += 1;
    const { rows } = await client.query(`
      INSERT INTO conversations (
        source_number_id, phone_number, conversation_status_id, current_step, qualification_context
      ) VALUES ($1, $2, $3, 'qualification', '{}'::jsonb)
      RETURNING id, phone_number
    `, [sourceNumberId, `15559${String(sequence).padStart(6, '0')}`, activeStatusId]);
    return rows[0];
  };

  const seedEvent = async (conversationId, suffix) => {
    const token = `token-${suffix}`;
    const { rows } = await client.query(`
      INSERT INTO inbound_events (
        instance_name, external_message_id, event_fingerprint, dedupe_key,
        source_number_id, phone_number, queue_key, event_type, normalized_event,
        should_process, processing_status, processing_token, processing_phase
      )
      SELECT 'v31-sql-test', $2, $2, $2, $3::bigint, phone_number, $3::bigint::text || ':' || phone_number,
             'messages.upsert', 'message', TRUE, 'processing', $4, 'orchestrating'
      FROM conversations WHERE id = $1
      RETURNING id
    `, [conversationId, `event-${suffix}`, sourceNumberId, token]);
    return { inboundEventId: rows[0].id, token };
  };

  test('08/09/16 accept a v3.1 policy/validation/decision and 09 persists the decision own version', async () => {
    sequence += 1;
    const suffix = `v31-${sequence}`;
    const conversation = await seedConversation();
    const event = await seedEvent(conversation.id, suffix);

    await client.query(routeSql, [
      event.inboundEventId, event.token, conversation.id, sourceNumberId, conversation.phone_number,
      'enforce', 'test-rule-v31', 'service', 'text', `message-${event.inboundEventId}`, null,
      'pandereta de 3 metros con alambre púa', { source: 'integration-test' },
    ]);

    const policyDigest = `policy-${suffix}`;
    const proposalDigest = `proposal-${suffix}`;
    const decisionId = `decision-${suffix}`;
    const deliveryKey = `delivery-${suffix}`;
    const snapshotDigest = `snapshot-${suffix}`;
    const decisionDigest = `decision-digest-${suffix}`;
    const replyText = 'Anoté el alambre de púas. ¿Podrías confirmar la pandereta?';
    const replySha256 = createHash('sha256').update(replyText, 'utf8').digest('hex');

    const policy = { version: 'ai_prd_turn_policy/v3.1', policy_digest: policyDigest, turn: { id: String(event.inboundEventId), conversation_id: String(conversation.id) } };
    const proposal = { version: 'ai_conversation_proposal/v3.1', policy_digest: policyDigest };
    const validation = {
      version: 'conversation_validation_result/v3.1', valid: true,
      policy_digest: policyDigest, proposal_digest: proposalDigest, errors: [],
    };
    const decision = {
      version: 'validated_conversation_decision/v3.1',
      decision_id: decisionId,
      turn_id: String(event.inboundEventId),
      conversation_id: String(conversation.id),
      conversation_revision_expected: 0,
      expected_snapshot_digest: snapshotDigest,
      policy_digest: policyDigest,
      proposal_digest: proposalDigest,
      reply: { text: replyText, sha256: replySha256, delivery_key: deliveryKey },
      state_mutations: [{ operation: 'set', field: 'commune', item_id: null, projected_value: 'Lo Prado' }],
      effect_commands: [],
    };

    const prepared = await client.query(persistAuthoritySql, [
      event.inboundEventId, event.token, conversation.id, sourceNumberId, conversation.phone_number,
      'text', `message-${event.inboundEventId}`, 'pandereta de 3 metros con alambre púa',
      { source: 'integration-test' }, 'service', decisionId, policy, proposal, validation, decision,
      'integration-provider', 'integration-model', decisionDigest,
    ]);
    expect(prepared.rows[0].decision_matches).toBe(true);

    const committed = await client.query(commitSql, [decisionId, event.token, snapshotDigest]);
    expect(committed.rows).toHaveLength(1);
    expect(committed.rows[0].raw_payload.version).toBe('validated_conversation_decision/v3.1');
    expect(committed.rows[0].v3_persisted_qualification_context.commune).toBe('Lo Prado');

    const recovered = await client.query(prepareSql, [event.inboundEventId]);
    expect(recovered.rows[0].decision_matches).toBe(true);
    expect(recovered.rows[0].v3_decision.version).toBe('validated_conversation_decision/v3.1');
  });

  test('15 accepts a v3.1 policy for a contingency fallback', async () => {
    sequence += 1;
    const suffix = `v31-contingency-${sequence}`;
    const conversation = await seedConversation();
    const event = await seedEvent(conversation.id, suffix);

    await client.query(routeSql, [
      event.inboundEventId, event.token, conversation.id, sourceNumberId, conversation.phone_number,
      'enforce', 'test-rule-v31c', 'service', 'text', `message-${event.inboundEventId}`, null,
      'algo salió mal', { source: 'integration-test' },
    ]);

    const policyDigest = `policy-${suffix}`;
    const decisionId = `decision-${suffix}`;
    const decisionDigest = `decision-digest-${suffix}`;
    const replyText = 'Derivé el caso al equipo para revisión.';
    const replySha256 = createHash('sha256').update(replyText, 'utf8').digest('hex');
    const policy = { version: 'ai_prd_turn_policy/v3.1', policy_digest: policyDigest, turn: { id: String(event.inboundEventId) } };
    const decision = {
      version: 'system_contingency_decision/v3',
      decision_id: decisionId,
      expected_snapshot_digest: `snapshot-${suffix}`,
      policy_digest: policyDigest,
      decision_digest: decisionDigest,
      reply: { text: replyText, sha256: replySha256, delivery_key: `delivery-${suffix}` },
      state_mutations: [],
      effect_commands: [],
    };

    const prepared = await client.query(prepareContingencySql, [
      event.inboundEventId, event.token, policy, decision, null,
    ]);
    expect(prepared.rows[0].decision_matches).toBe(true);
  });
});
