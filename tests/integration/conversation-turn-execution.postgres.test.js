import fs from 'node:fs';
import { createRequire } from 'node:module';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const {
  compileV3TurnPolicy,
  digestObject,
  validateV3AiProposal,
  authorizeV3ConversationDecision,
} = require('../fixtures/workflow-nodes/shared/v3-contract-runtime.js');
const {
  planV3Recovery,
} = require('../fixtures/workflow-nodes/shared/v3-saga-runtime.js');

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
  const prepareSql = query('08_prepare_v3_decision');
  const commitSql = query('09_commit_v3_turn');
  const transitionSql = query('10_transition_v3_execution');
  const prepareEffectSql = query('11_prepare_v3_effect');
  const recordEffectSql = query('12_record_v3_effect_result');
  const reconcileEffectSql = query('13_reconcile_v3_effect');
  const contingencySql = query('14_commit_v3_contingency');
  const prepareContingencySql = query('15_prepare_v3_contingency');
  const persistAuthoritySql = query('16_persist_v3_turn_authority');
  const persistHandoffEffectSql = query('17_persist_v3_handoff_effect');

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

  const seedUnboundEvent = async (phoneNumber, suffix) => {
    const token = `token-${suffix}`;
    const { rows } = await client.query(`
      INSERT INTO inbound_events (
        instance_name, external_message_id, event_fingerprint, dedupe_key,
        source_number_id, phone_number, queue_key, event_type, normalized_event,
        should_process, processing_status, processing_token, processing_phase
      ) VALUES (
        'v3-test', $1::text, $1::text, $1::text, $2::bigint, $3::text,
        $2::bigint::text || ':' || $3::text,
        'messages.upsert', 'message', TRUE, 'processing', $4::text, 'orchestrating'
      )
      RETURNING id
    `, [`event-${suffix}`, sourceNumberId, phoneNumber, token]);
    return { inboundEventId: rows[0].id, token };
  };

  const seedConversation = async (qualification = { city: 'Santiago' }) => {
    sequence += 1;
    const { rows } = await client.query(`
      INSERT INTO conversations (
        source_number_id, phone_number, conversation_status_id,
        current_step, qualification_context
      ) VALUES ($1, $2, $3, 'qualification', $4::jsonb)
      RETURNING id, phone_number, qualification_context
    `, [sourceNumberId, `15559${String(sequence).padStart(6, '0')}`, activeStatusId, qualification]);
    return rows[0];
  };

  const routeEarly = ({
    event,
    conversationId = null,
    phoneNumber,
    routeMode = 'enforce',
    routeRuleId = 'test-early-route',
    textBody = 'Necesito una cotización',
  }) => client.query(routeSql, [
    event.inboundEventId,
    event.token,
    conversationId,
    sourceNumberId,
    phoneNumber,
    routeMode,
    routeRuleId,
    'service',
    'text',
    `message-${event.inboundEventId}`,
    null,
    textBody,
    { source: 'integration-test' },
  ]);

  const seedTurn = async ({
    qualification = { city: 'Santiago' },
    stateMutations = [{ operation: 'set', field: 'service', projected_value: 'installation' }],
    effectCommands = [],
    replyText = 'Sí, puedo ayudarte exactamente.\n¿En qué comuna sería?',
    contingency = false,
  } = {}) => {
    const conversation = await seedConversation(qualification);
    const suffix = `turn-${sequence}`;
    const event = await seedEvent(conversation.id, suffix);
    const decisionId = `decision-${suffix}`;
    const deliveryKey = `delivery-${suffix}`;
    const snapshotDigest = `snapshot-${suffix}`;
    const policyDigest = `policy-${suffix}`;
    const proposalDigest = `proposal-${suffix}`;
    const decisionDigest = `decision-digest-${suffix}`;
    const policy = {
      version: 'ai_prd_turn_policy/v3',
      policy_digest: policyDigest,
      turn: { id: String(event.inboundEventId), conversation_id: String(conversation.id) },
    };
    const outputPayload = contingency ? {
      version: 'system_contingency_decision/v3',
      decision_id: decisionId,
      expected_snapshot_digest: snapshotDigest,
      policy_digest: policyDigest,
      decision_digest: decisionDigest,
      reply: { text: replyText, sha256: `reply-${suffix}`, delivery_key: deliveryKey },
      state_mutations: [],
      effect_commands: [{
        type: 'internal_handoff',
        operation_key: `handoff-${suffix}`,
        payload_digest: `handoff-payload-${suffix}`,
        required_before_reply: true,
        payload: {
          motive: 'v3_recovery', area: 'sales', area_label: 'Ventas',
          priority: 'alta', owner: 'Equipo Ventas', trigger: suffix,
        },
      }],
    } : {
      version: 'validated_conversation_decision/v3',
      decision_id: decisionId,
      turn_id: String(event.inboundEventId),
      conversation_id: String(conversation.id),
      conversation_revision_expected: 0,
      expected_snapshot_digest: snapshotDigest,
      policy_digest: policyDigest,
      proposal_digest: proposalDigest,
      reply: { text: replyText, sha256: `reply-${suffix}`, delivery_key: deliveryKey },
      state_mutations: stateMutations,
      effect_commands: effectCommands,
    };
    const routed = await routeEarly({
      event,
      conversationId: conversation.id,
      phoneNumber: conversation.phone_number,
      routeRuleId: 'test-rule',
      textBody: 'Necesito una cotización',
    });
    expect(routed.rows).toHaveLength(1);
    expect(routed.rows[0].route_acquired).toBe(true);

    const proposal = { version: 'ai_conversation_proposal/v3', policy_digest: policyDigest };
    const validation = {
      version: 'conversation_validation_result/v3',
      valid: true,
      policy_digest: policyDigest,
      proposal_digest: proposalDigest,
      errors: [],
    };
    const prepared = contingency
      ? await client.query(prepareContingencySql, [
          event.inboundEventId, event.token, policy, outputPayload,
        ])
      : await client.query(persistAuthoritySql, [
          event.inboundEventId,
          event.token,
          conversation.id,
          sourceNumberId,
          conversation.phone_number,
          'text',
          `message-${event.inboundEventId}`,
          'Necesito una cotización',
          { source: 'integration-test' },
          'service',
          decisionId,
          policy,
          proposal,
          validation,
          outputPayload,
          'integration-provider',
          'integration-model',
          decisionDigest,
        ]);
    expect(prepared.rows[0].decision_matches).toBe(true);

    return {
      conversationId: conversation.id,
      inboundEventId: event.inboundEventId,
      token: event.token,
      advisorDecisionId: prepared.rows[0].advisor_decision_id,
      decisionId,
      deliveryKey,
      snapshotDigest,
      qualification,
      replyText,
      decision: outputPayload,
    };
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

  test('new contact acquires the v3 ledger before AI compilation', async () => {
    sequence += 1;
    const phoneNumber = `15558${String(sequence).padStart(6, '0')}`;
    const event = await seedUnboundEvent(phoneNumber, `early-route-${sequence}`);

    const routed = await routeEarly({ event, phoneNumber });

    expect(routed.rows).toHaveLength(1);
    expect(routed.rows[0]).toMatchObject({
      claim_valid: true,
      route_acquired: true,
      replayed: false,
      route_matches: true,
      state: 'routed',
    });
    expect(routed.rows[0].conversation_id).toBeTruthy();
    expect(routed.rows[0].incoming_message_id).toBeTruthy();

    const durable = await client.query(`
      SELECT
        (SELECT COUNT(*)::int FROM conversation_turn_executions
          WHERE inbound_event_id = $1 AND state = 'routed') AS ledger_rows,
        (SELECT COUNT(*)::int FROM messages
          WHERE inbound_event_id = $1 AND direction = 'incoming') AS incoming_rows,
        (SELECT COUNT(*)::int FROM advisor_decisions
          WHERE conversation_id = $2) AS advisor_rows
    `, [event.inboundEventId, routed.rows[0].conversation_id]);
    expect(durable.rows[0]).toEqual({ ledger_rows: 1, incoming_rows: 1, advisor_rows: 0 });
  });

  test('replays the same inbound against the original early ledger and incoming evidence', async () => {
    sequence += 1;
    const phoneNumber = `15558${String(sequence).padStart(6, '0')}`;
    const event = await seedUnboundEvent(phoneNumber, `early-replay-${sequence}`);
    const first = await routeEarly({ event, phoneNumber });
    const replay = await routeEarly({ event, phoneNumber });

    expect(first.rows[0].route_acquired).toBe(true);
    expect(replay.rows).toHaveLength(1);
    expect(replay.rows[0]).toMatchObject({
      route_acquired: false,
      replayed: true,
      route_matches: true,
      id: first.rows[0].id,
      conversation_id: first.rows[0].conversation_id,
      incoming_message_id: first.rows[0].incoming_message_id,
    });

    const counts = await client.query(`
      SELECT
        (SELECT COUNT(*)::int FROM conversation_turn_executions
          WHERE inbound_event_id = $1) AS ledger_rows,
        (SELECT COUNT(*)::int FROM messages
          WHERE inbound_event_id = $1 AND direction = 'incoming') AS incoming_rows
    `, [event.inboundEventId]);
    expect(counts.rows[0]).toEqual({ ledger_rows: 1, incoming_rows: 1 });
  });

  test('an active-turn race degrades without a v3 ledger or incoming message', async () => {
    const conversation = await seedConversation();
    const firstEvent = await seedEvent(conversation.id, `active-winner-${sequence}`);
    const winner = await routeEarly({
      event: firstEvent,
      conversationId: conversation.id,
      phoneNumber: conversation.phone_number,
    });
    await client.query(
      "UPDATE inbound_events SET processing_status = 'processed' WHERE id = $1",
      [firstEvent.inboundEventId],
    );
    const losingEvent = await seedEvent(conversation.id, `active-loser-${sequence}`);
    const loser = await routeEarly({
      event: losingEvent,
      conversationId: conversation.id,
      phoneNumber: conversation.phone_number,
    });

    expect(winner.rows[0].route_matches).toBe(true);
    expect(loser.rows).toHaveLength(1);
    expect(loser.rows[0]).toMatchObject({
      claim_valid: true,
      route_acquired: false,
      replayed: false,
      route_matches: false,
      route_failure_reason: 'active_turn_exists',
    });

    const losingWrites = await client.query(`
      SELECT
        (SELECT COUNT(*)::int FROM conversation_turn_executions
          WHERE inbound_event_id = $1) AS ledger_rows,
        (SELECT COUNT(*)::int FROM messages
          WHERE inbound_event_id = $1 AND direction = 'incoming') AS incoming_rows
    `, [losingEvent.inboundEventId]);
    expect(losingWrites.rows[0]).toEqual({ ledger_rows: 0, incoming_rows: 0 });
  });

  test('recovers the immutable authorized decision from the prepared execution', async () => {
    const turn = await seedTurn();
    const replay = await client.query(prepareSql, [turn.inboundEventId]);
    expect(replay.rows[0].decision_matches).toBe(true);
    expect(replay.rows[0].v3_decision).toEqual(turn.decision);
    await expect(client.query(
      "UPDATE advisor_decisions SET output_payload = '{\"changed\":true}' WHERE id = $1",
      [turn.advisorDecisionId],
    )).rejects.toThrow(/immutable/i);
  });

  test('rejects stale token and snapshot without mutating state or creating delivery', async () => {
    const staleToken = await seedTurn();
    expect((await client.query(commitSql, [
      staleToken.decisionId, 'stale-token', staleToken.snapshotDigest,
    ])).rows).toHaveLength(0);

    const staleSnapshot = await seedTurn();
    await client.query(
      "UPDATE conversations SET qualification_context = qualification_context || '{\"city\":\"Valparaiso\"}' WHERE id = $1",
      [staleSnapshot.conversationId],
    );
    expect((await client.query(commitSql, [
      staleSnapshot.decisionId, staleSnapshot.token, staleSnapshot.snapshotDigest,
    ])).rows).toHaveLength(0);

    const counts = await client.query(`
      SELECT
        (SELECT COUNT(*)::int FROM messages WHERE direction = 'outgoing'
          AND idempotency_key IN ($1, $2)) AS messages,
        (SELECT COUNT(*)::int FROM conversation_turn_executions
          WHERE decision_id IN ($3, $4) AND state = 'ready_to_commit') AS untouched
    `, [staleToken.deliveryKey, staleSnapshot.deliveryKey,
      staleToken.decisionId, staleSnapshot.decisionId]);
    expect(counts.rows[0]).toEqual({ messages: 0, untouched: 2 });
  });

  test('commits once under concurrency and replays the exact delivery intent', async () => {
    const turn = await seedTurn();
    const other = new pg.Client(connection);
    await other.connect();
    try {
      const [left, right] = await Promise.all([
        client.query(commitSql, [turn.decisionId, turn.token, turn.snapshotDigest]),
        other.query(commitSql, [turn.decisionId, turn.token, turn.snapshotDigest]),
      ]);
      const concurrentRows = [left, right].flatMap((result) => result.rows);
      expect([1, 2]).toContain(concurrentRows.length);
      const winners = concurrentRows.filter((row) => row.replayed === false);
      expect(winners).toHaveLength(1);
      for (const row of concurrentRows) {
        expect(row.delivery_message_id).toBe(winners[0].delivery_message_id);
      }
      const replay = await client.query(commitSql, [turn.decisionId, turn.token, turn.snapshotDigest]);
      expect(replay.rows).toHaveLength(1);
      expect(replay.rows[0].replayed).toBe(true);
      expect(replay.rows[0].delivery_message_id).toBe(winners[0].delivery_message_id);
      expect(replay.rows[0].text_body).toBe(turn.replyText);

      const persisted = await client.query(`
        SELECT c.qualification_context, e.state, e.state_receipt,
          COUNT(m.id)::int AS message_count,
          COUNT(a.id) FILTER (WHERE a.event_name = 'v3_turn_committed')::int AS audit_count
        FROM conversations c
        JOIN conversation_turn_executions e ON e.conversation_id = c.id
        LEFT JOIN messages m ON m.idempotency_key = e.delivery_key
        LEFT JOIN audit_logs a ON a.entity_type = 'conversation_turn_execution' AND a.entity_id = e.id
        WHERE e.decision_id = $1
        GROUP BY c.id, e.id
      `, [turn.decisionId]);
      expect(persisted.rows[0].qualification_context).toEqual({ city: 'Santiago', service: 'installation' });
      expect(persisted.rows[0].state).toBe('delivery_pending');
      expect(persisted.rows[0].state_receipt.decision_id).toBe(turn.decisionId);
      expect(persisted.rows[0].message_count).toBe(1);
      expect(persisted.rows[0].audit_count).toBe(1);
    } finally {
      await other.end();
    }
  });

  test('commits the exact decision contract emitted by the canonical runtime', async () => {
    const qualification = { name: 'Juan', city: 'Santiago' };
    const conversation = await seedConversation(qualification);
    const suffix = `runtime-contract-${sequence}`;
    const event = await seedEvent(conversation.id, suffix);
    const messageText = 'Soy Pedro y necesito 25 unidades';
    const routed = await routeEarly({
      event,
      conversationId: conversation.id,
      phoneNumber: conversation.phone_number,
      routeRuleId: 'runtime-contract',
      textBody: messageText,
    });
    expect(routed.rows[0]).toMatchObject({
      route_acquired: true,
      route_matches: true,
      state: 'routed',
    });
    const policy = compileV3TurnPolicy({
      turn: {
        id: String(event.inboundEventId),
        conversation_id: String(conversation.id),
        conversation_revision: 1,
        message: { id: `message-${suffix}`, text: messageText },
      },
      history: { messages: [] },
      facts: [{
        fact_id: 'fact:name',
        field: 'name',
        value: 'Juan',
        mutability: 'customer_correctable',
        source: { message_id: 'previous-message', evidence_digest: 'previous-evidence' },
      }],
      goals: [
        { goal_id: 'name', status: 'resolved' },
        { goal_id: 'quantity', status: 'unresolved' },
      ],
      allowed_mutations: [
        { operation: 'replace', concept: 'name', field: 'name', current_fact_id: 'fact:name' },
        { operation: 'set', concept: 'quantity', field: 'quantity' },
      ],
      grounding: {},
      claim_rules: [],
      effect_permissions: [],
      effect_requirements: [],
    });
    const proposal = {
      version: 'ai_conversation_proposal/v3',
      policy_digest: policy.policy_digest,
      reply_text: 'Gracias, Pedro. Registré las 25 unidades.',
      primary_request: null,
      observations: [
        {
          id: 'observation-name',
          concept: 'name',
          raw_value: 'Pedro',
          normalized_value: 'Pedro',
          evidence_quote: 'Pedro',
          evidence_occurrence: 1,
          grounding_ref: null,
          resolves_goal_ids: ['name'],
        },
        {
          id: 'observation-quantity',
          concept: 'quantity',
          raw_value: '25 unidades',
          normalized_value: '25 unidades',
          evidence_quote: '25 unidades',
          evidence_occurrence: 1,
          grounding_ref: null,
          resolves_goal_ids: ['quantity'],
        },
      ],
      state_mutations: [
        {
          operation: 'replace',
          field: 'name',
          observation_id: 'observation-name',
          replaces_fact_id: 'fact:name',
        },
        {
          operation: 'set',
          field: 'quantity',
          observation_id: 'observation-quantity',
          replaces_fact_id: null,
        },
      ],
      effect_requests: [],
    };
    const validation = validateV3AiProposal(policy, proposal);
    expect(validation.valid).toBe(true);
    const decision = authorizeV3ConversationDecision(policy, proposal, validation);
    expect(decision.version).toBe('validated_conversation_decision/v3');
    expect(decision.state_mutations).toEqual([
      expect.objectContaining({ operation: 'replace', field: 'name', projected_value: 'Pedro' }),
      expect.objectContaining({ operation: 'set', field: 'quantity', projected_value: '25 unidades' }),
    ]);

    const attached = await client.query(persistAuthoritySql, [
      event.inboundEventId,
      event.token,
      conversation.id,
      sourceNumberId,
      conversation.phone_number,
      'text',
      `message-${event.inboundEventId}`,
      messageText,
      { source: 'integration-test' },
      'service',
      decision.decision_id,
      policy,
      proposal,
      validation,
      decision,
      'integration-provider',
      'integration-model',
      digestObject(decision),
    ]);
    expect(attached.rows).toHaveLength(1);
    expect(attached.rows[0]).toMatchObject({
      decision_matches: true,
      decision_id: decision.decision_id,
      state: 'ready_to_commit',
    });
    expect(attached.rows[0].advisor_decision_id).toBeTruthy();

    const committed = await client.query(commitSql, [
      decision.decision_id,
      event.token,
      decision.expected_snapshot_digest,
    ]);

    expect(committed.rows).toHaveLength(1);
    expect(committed.rows[0].text_body).toBe(decision.reply.text);
    expect(committed.rows[0].raw_payload).toMatchObject({
      version: decision.version,
      decision_id: decision.decision_id,
    });
    expect(committed.rows[0].raw_payload).not.toHaveProperty('schema');
    const state = await client.query(
      'SELECT qualification_context FROM conversations WHERE id = $1',
      [conversation.id],
    );
    expect(state.rows[0].qualification_context).toEqual({
      name: 'Pedro',
      city: 'Santiago',
      quantity: '25 unidades',
    });
  });

  test('rejects legacy mutation aliases instead of accepting a parallel contract', async () => {
    await expect(client.query(
      `SELECT apply_v3_state_mutations(
        '{}'::jsonb,
        '[{"operation":"set","field":"quantity","value":"25"}]'::jsonb
      )`,
    )).rejects.toThrow(/unsupported v3 mutation operation/i);

    await expect(client.query(
      `SELECT apply_v3_state_mutations(
        '{"quantity":"25"}'::jsonb,
        '[{"operation":"remove","field":"quantity"}]'::jsonb
      )`,
    )).rejects.toThrow(/unsupported v3 mutation operation/i);
  });

  test('serializes different active turns for one conversation', async () => {
    const conversation = await seedConversation();
    const first = await seedEvent(conversation.id, `serial-a-${sequence}`);
    const second = await seedEvent(conversation.id, `serial-b-${sequence}`, 'received');
    const other = new pg.Client(connection);
    await other.connect();
    try {
      const routeValues = (event) => [
        event.inboundEventId, event.token, conversation.id, sourceNumberId,
        conversation.phone_number, 'enforce', 'serial', 'service', 'text',
        `message-${event.inboundEventId}`, null, 'Necesito una cotización',
        { source: 'integration-test' },
      ];
      const [a, b] = await Promise.all([
        client.query(routeSql, routeValues(first)),
        other.query(routeSql, routeValues(second)),
      ]);
      expect(a.rows).toHaveLength(1);
      expect(b.rows).toHaveLength(1);
      expect(a.rows[0].route_matches).toBe(true);
      expect(b.rows[0]).toMatchObject({ claim_valid: false, route_matches: false });
      const activeEvent = a.rows[0].inbound_event_id;
      await client.query(
        "UPDATE conversation_turn_executions SET state = 'aborted' WHERE inbound_event_id = $1",
        [activeEvent],
      );
      await client.query(
        "UPDATE inbound_events SET processing_status = 'processed' WHERE id = $1",
        [first.inboundEventId],
      );
      await client.query(
        "UPDATE inbound_events SET processing_status = 'processing' WHERE id = $1",
        [second.inboundEventId],
      );
      const retried = await client.query(routeSql, routeValues(second));
      expect(retried.rows[0].route_acquired).toBe(true);
    } finally {
      await other.end();
    }
  });

  test('records effect receipts and never retries an unknown outcome blindly', async () => {
    const effect = {
      type: 'create_lead', operation_key: `effect-${sequence + 1}`,
      payload: { sku: 'svc-1' }, payload_digest: `payload-${sequence + 1}`,
      required_before_reply: true,
    };
    const turn = await seedTurn({ effectCommands: [effect] });
    const claimed = await client.query(prepareEffectSql, [
      turn.decisionId, effect.operation_key, effect.type, effect.payload, effect.payload_digest,
    ]);
    expect(claimed.rows[0].should_execute).toBe(true);
    const unknown = await client.query(recordEffectSql, [
      effect.operation_key, effect.payload_digest, claimed.rows[0].claim_token,
      'unknown', { provider: 'timeout' }, null, 'timeout after dispatch',
    ]);
    expect(unknown.rows[0].execution_state).toBe('reconciliation_required');

    const blindRetry = await client.query(prepareEffectSql, [
      turn.decisionId, effect.operation_key, effect.type, effect.payload, effect.payload_digest,
    ]);
    expect(blindRetry.rows[0].should_execute).toBe(false);
    expect(blindRetry.rows[0].status).toBe('unknown');
    expect((await client.query(reconcileEffectSql, [
      effect.operation_key, 'wrong-digest', 'succeeded', { marker: effect.operation_key },
    ])).rows).toHaveLength(0);
  });

  test('claims one canonical create_lead effect with its durable decision and executor context', async () => {
    const effect = {
      type: 'create_lead',
      operation_key: `create-lead-${sequence + 1}`,
      payload: { conversation_id: 'pending', turn_id: 'pending', reason_observation_ids: [] },
      payload_digest: `create-lead-payload-${sequence + 1}`,
      required_before_reply: true,
    };
    const turn = await seedTurn({
      qualification: {
        service: 'installation',
        city: 'Santiago',
        requirement: '25 square meters',
      },
      effectCommands: [effect],
    });
    const claimed = await client.query(prepareEffectSql, [
      turn.decisionId,
      effect.operation_key,
      effect.type,
      effect.payload,
      effect.payload_digest,
    ]);

    expect(claimed.rows).toHaveLength(1);
    expect(claimed.rows[0]).toMatchObject({
      should_execute: true,
      operation_type: 'create_lead',
      conversation_id: turn.conversationId,
      qualification_context: {
        service: 'installation',
        city: 'Santiago',
        requirement: '25 square meters',
      },
      v3_effect_command: effect,
    });
    expect(claimed.rows[0].v3_decision.decision_id).toBe(turn.decisionId);
    const replay = await client.query(prepareEffectSql, [
      turn.decisionId,
      effect.operation_key,
      effect.type,
      effect.payload,
      effect.payload_digest,
    ]);
    expect(replay.rows[0].should_execute).toBe(false);
  });

  test('executes one canonical handoff effect and records its handoff_id receipt once', async () => {
    const effect = {
      type: 'handoff',
      operation_key: `handoff-effect-${sequence + 1}`,
      payload: { conversation_id: 'pending', turn_id: 'pending', reason_observation_ids: [] },
      payload_digest: `handoff-effect-payload-${sequence + 1}`,
      required_before_reply: true,
    };
    const turn = await seedTurn({ effectCommands: [effect] });
    const claimed = await client.query(prepareEffectSql, [
      turn.decisionId,
      effect.operation_key,
      effect.type,
      effect.payload,
      effect.payload_digest,
    ]);

    const execute = () => client.query(persistHandoffEffectSql, [
      effect.operation_key,
      turn.decisionId,
      effect.payload_digest,
      claimed.rows[0].claim_token,
    ]);
    const first = await execute();
    const replay = await execute();
    expect(first.rows[0].handoff_id).toBe(replay.rows[0].handoff_id);
    expect(first.rows[0].v3_effect_receipt).toMatchObject({
      version: 'v3_effect_receipt/v1',
      operation_key: effect.operation_key,
      effect_type: 'handoff',
      status: 'succeeded',
    });
    expect(String(first.rows[0].v3_effect_receipt.handoff_id)).toBe(first.rows[0].handoff_id);
    expect(first.rows[0].v3_effect_receipt).not.toHaveProperty('id');

    const invalidReceipt = await client.query(recordEffectSql, [
      effect.operation_key,
      effect.payload_digest,
      claimed.rows[0].claim_token,
      'succeeded',
      {
        ...first.rows[0].v3_effect_receipt,
        id: first.rows[0].handoff_id,
        handoff_id: undefined,
      },
      first.rows[0].handoff_id,
      null,
    ]);
    expect(invalidReceipt.rows).toHaveLength(0);

    const recorded = await client.query(recordEffectSql, [
      effect.operation_key,
      effect.payload_digest,
      claimed.rows[0].claim_token,
      'succeeded',
      first.rows[0].v3_effect_receipt,
      first.rows[0].handoff_id,
      null,
    ]);
    expect(recorded.rows[0]).toMatchObject({ execution_state: 'ready_to_commit' });
    expect(recorded.rows[0].v3_decision).toEqual(turn.decision);
    expect(recorded.rows[0].effect_receipt_refs[0]).toMatchObject({
      operation_key: effect.operation_key,
      status: 'succeeded',
    });
    expect(String(recorded.rows[0].effect_receipt_refs[0].handoff_id)).toBe(first.rows[0].handoff_id);

    const count = await client.query(
      'SELECT COUNT(*)::int AS count FROM handoffs WHERE idempotency_key = $1',
      [effect.operation_key],
    );
    expect(count.rows[0].count).toBe(1);
  });

  test('requires recovery for inconclusive or duplicate exact-key reconciliation', async () => {
    for (const resolution of ['inconclusive', 'duplicate']) {
      const effect = {
        type: 'create_lead', operation_key: `effect-${resolution}-${sequence + 1}`,
        payload: { resolution }, payload_digest: `payload-${resolution}-${sequence + 1}`,
        required_before_reply: true,
      };
      const turn = await seedTurn({ effectCommands: [effect] });
      const claim = await client.query(prepareEffectSql, [
        turn.decisionId, effect.operation_key, effect.type, effect.payload, effect.payload_digest,
      ]);
      await client.query(recordEffectSql, [
        effect.operation_key, effect.payload_digest, claim.rows[0].claim_token,
        'unknown', {}, null, 'ambiguous',
      ]);
      const reconciled = await client.query(reconcileEffectSql, [
        effect.operation_key, effect.payload_digest, resolution,
        { exact_operation_key: effect.operation_key, matches: resolution === 'duplicate' ? 2 : 0 },
      ]);
      expect(reconciled.rows[0].execution_state).toBe('reconciliation_required');
      expect(reconciled.rows[0].reconciliation_required).toBe(true);
      if (resolution === 'duplicate') {
        expect(reconciled.rows[0].last_error.code).toBe('duplicate_effect_incident');
      }
    }
  });

  test('permits one retry only after exact-key proof of no effect', async () => {
    const effect = {
      type: 'create_lead', operation_key: `effect-noop-${sequence + 1}`,
      payload: { sku: 'svc-2' }, payload_digest: `payload-noop-${sequence + 1}`,
      required_before_reply: true,
    };
    const turn = await seedTurn({ effectCommands: [effect] });
    const first = await client.query(prepareEffectSql, [
      turn.decisionId, effect.operation_key, effect.type, effect.payload, effect.payload_digest,
    ]);
    await client.query(recordEffectSql, [
      effect.operation_key, effect.payload_digest, first.rows[0].claim_token,
      'unknown', {}, null, 'ambiguous',
    ]);
    const proof = await client.query(reconcileEffectSql, [
      effect.operation_key, effect.payload_digest, 'no_effect_proven',
      { exact_operation_key: effect.operation_key, matches: 0, complete_search: true },
    ]);
    expect(proof.rows[0].execution_state).toBe('effects_pending');
    const authorized = await client.query(prepareEffectSql, [
      turn.decisionId, effect.operation_key, effect.type, effect.payload, effect.payload_digest,
    ]);
    expect(authorized.rows[0].should_execute).toBe(true);
    const duplicateClaim = await client.query(prepareEffectSql, [
      turn.decisionId, effect.operation_key, effect.type, effect.payload, effect.payload_digest,
    ]);
    expect(duplicateClaim.rows[0].should_execute).toBe(false);
  });

  test('creates one receipted contingency handoff before exact copy and preserves state', async () => {
    const replyText = 'No pude completar la gestión automática. Te derivé al equipo para revisión.';
    const turn = await seedTurn({
      qualification: { city: 'Santiago', service: 'installation', budget: 'pending' },
      stateMutations: [], replyText, contingency: true,
    });
    const first = await client.query(contingencySql, [turn.decisionId, turn.token]);
    const replay = await client.query(contingencySql, [turn.decisionId, turn.token]);
    expect(first.rows[0].handoff_id).toBe(replay.rows[0].handoff_id);
    expect(first.rows[0].delivery_message_id).toBe(replay.rows[0].delivery_message_id);
    expect(first.rows[0].text_body).toBe(replyText);
    expect(String(first.rows[0].handoff_receipt.handoff_id)).toBe(first.rows[0].handoff_id);
    expect(first.rows[0].handoff_receipt).not.toHaveProperty('id');

    const persisted = await client.query(`
      SELECT c.qualification_context,
        COUNT(DISTINCT h.id)::int AS handoffs,
        COUNT(DISTINCT m.id)::int AS messages
      FROM conversations c
      LEFT JOIN handoffs h ON h.conversation_id = c.id AND h.idempotency_key = $2
      LEFT JOIN messages m ON m.conversation_id = c.id AND m.idempotency_key = $3
      WHERE c.id = $1 GROUP BY c.id
    `, [turn.conversationId, `handoff-turn-${sequence}`, turn.deliveryKey]);
    expect(persisted.rows[0].qualification_context).toEqual({
      city: 'Santiago', service: 'installation', budget: 'pending',
    });
    expect(persisted.rows[0].handoffs).toBe(1);
    expect(persisted.rows[0].messages).toBe(1);
  });

  test('invalid proposal repairs once then commits one contingency handoff and outbox', async () => {
    const qualification = { city: 'Santiago', service: 'installation' };
    const conversation = await seedConversation(qualification);
    const event = await seedEvent(conversation.id, `repair-contingency-${sequence}`);
    const routed = await routeEarly({
      event,
      conversationId: conversation.id,
      phoneNumber: conversation.phone_number,
      routeRuleId: 'repair-contingency',
    });
    expect(routed.rows[0].state).toBe('routed');

    const policy = compileV3TurnPolicy({
      turn: {
        id: String(event.inboundEventId),
        conversation_id: String(conversation.id),
        conversation_revision: 0,
        message: { id: `message-${event.inboundEventId}`, text: 'Necesito ayuda' },
      },
      history: { messages: [] },
      facts: [],
      goals: [],
      allowed_mutations: [],
      grounding: {},
      claim_rules: [],
      effect_permissions: [],
      effect_requirements: [],
    });
    const invalidValidation = validateV3AiProposal(policy, null);
    const firstRecovery = planV3Recovery({
      policy,
      validation: invalidValidation,
      repairAttempt: 0,
      preTurnState: qualification,
    });
    expect(firstRecovery.action).toBe('repair');
    expect(firstRecovery.repair_request.repair_attempt).toBe(1);

    const expectedSnapshotDigest = digestObject({
      conversation_revision: policy.turn.conversation_revision,
      facts: policy.facts,
    });
    const terminalRecovery = planV3Recovery({
      policy,
      validation: invalidValidation,
      repairAttempt: firstRecovery.repair_request.repair_attempt,
      preTurnState: qualification,
      expectedSnapshotDigest,
    });
    expect(terminalRecovery.action).toBe('contingency');
    expect(terminalRecovery.decision).toMatchObject({
      version: 'system_contingency_decision/v3',
      state_mutations: [],
    });

    const prepared = await client.query(prepareContingencySql, [
      event.inboundEventId,
      event.token,
      policy,
      terminalRecovery.decision,
    ]);
    expect(prepared.rows[0]).toMatchObject({
      state: 'prepared',
      decision_matches: true,
    });

    const firstCommit = await client.query(contingencySql, [
      terminalRecovery.decision.decision_id,
      event.token,
    ]);
    const replay = await client.query(contingencySql, [
      terminalRecovery.decision.decision_id,
      event.token,
    ]);
    expect(firstCommit.rows[0]).toMatchObject({ state: 'delivery_pending', replayed: false });
    expect(replay.rows[0]).toMatchObject({ state: 'delivery_pending', replayed: true });
    expect(replay.rows[0].handoff_id).toBe(firstCommit.rows[0].handoff_id);
    expect(replay.rows[0].delivery_message_id).toBe(firstCommit.rows[0].delivery_message_id);

    const durable = await client.query(`
      SELECT conversation.qualification_context,
        COUNT(DISTINCT handoff.id)::int AS handoffs,
        COUNT(DISTINCT message.id)::int AS outbox_messages
      FROM conversations conversation
      LEFT JOIN handoffs handoff ON handoff.conversation_id = conversation.id
        AND handoff.idempotency_key = $2
      LEFT JOIN messages message ON message.conversation_id = conversation.id
        AND message.idempotency_key = $3
        AND message.direction = 'outgoing'
      WHERE conversation.id = $1
      GROUP BY conversation.id
    `, [
      conversation.id,
      terminalRecovery.decision.effect_commands[0].operation_key,
      terminalRecovery.decision.reply.delivery_key,
    ]);
    expect(durable.rows[0]).toEqual({
      qualification_context: qualification,
      handoffs: 1,
      outbox_messages: 1,
    });
  });

  test('persists a generated contingency decision before releasing its handoff', async () => {
    const conversation = await seedConversation({ city: 'Santiago', service: 'installation' });
    const event = await seedEvent(conversation.id, `generated-contingency-${sequence}`);
    const policy = {
      version: 'ai_prd_turn_policy/v3', policy_digest: `policy-generated-${sequence}`,
      turn: { id: `turn-generated-${sequence}` },
      state_authority: { expected_snapshot_digest: `snapshot-generated-${sequence}` },
    };
    const decisionId = `decision-generated-${sequence}`;
    const operationKey = `handoff-generated-${sequence}`;
    const deliveryKey = `delivery-generated-${sequence}`;
    const decision = {
      version: 'system_contingency_decision/v3', decision_id: decisionId,
      decision_digest: `decision-digest-generated-${sequence}`,
      expected_snapshot_digest: policy.state_authority.expected_snapshot_digest,
      policy_digest: policy.policy_digest,
      reply: { text: 'Derivé el caso al equipo para revisión.', sha256: 'reply-generated', delivery_key: deliveryKey },
      state_mutations: [],
      effect_commands: [{
        type: 'internal_handoff', operation_key: operationKey,
        payload_digest: `payload-generated-${sequence}`, required_before_reply: true,
        payload: { motive: 'v3_recovery', area: 'sales', area_label: 'Ventas', priority: 'alta', owner: 'Equipo Ventas', trigger: `generated-${sequence}` },
      }],
    };
    await routeEarly({
      event,
      conversationId: conversation.id,
      phoneNumber: conversation.phone_number,
      routeRuleId: 'generated-contingency',
    });
    const prepared = await client.query(prepareContingencySql, [
      event.inboundEventId, event.token, policy, decision,
    ]);
    expect(prepared.rows[0].decision_matches).toBe(true);
    expect(prepared.rows[0].state).toBe('prepared');
    const committed = await client.query(contingencySql, [decisionId, event.token]);
    expect(committed.rows[0].handoff_receipt.operation_key).toBe(operationKey);
    expect(committed.rows[0].text_body).toBe(decision.reply.text);
  });

  test('stores one delivery receipt through the legal terminal transition', async () => {
    const turn = await seedTurn({ stateMutations: [] });
    const committed = await client.query(commitSql, [turn.decisionId, turn.token, turn.snapshotDigest]);
    const receipt = { provider_message_id: 'wamid.v3.1', delivered_bytes_sha256: `reply-turn-${sequence}` };
    const delivered = await client.query(transitionSql, [
      turn.decisionId, 'delivery_pending', 'delivered', false, null,
      committed.rows[0].delivery_message_id, receipt, null,
    ]);
    expect(delivered.rows[0].delivery_receipt_ref).toEqual(receipt);
    expect((await client.query(transitionSql, [
      turn.decisionId, 'delivery_pending', 'delivered', false, null,
      committed.rows[0].delivery_message_id, receipt, null,
    ])).rows).toHaveLength(0);
  });
});
