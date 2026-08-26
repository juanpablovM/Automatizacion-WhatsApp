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
  const prepareSql = query('08_prepare_v3_decision');
  const commitSql = query('09_commit_v3_turn');
  const transitionSql = query('10_transition_v3_execution');
  const prepareEffectSql = query('11_prepare_v3_effect');
  const recordEffectSql = query('12_record_v3_effect_result');
  const reconcileEffectSql = query('13_reconcile_v3_effect');
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

  const seedTurn = async ({
    qualification = { city: 'Santiago' },
    mutations = [{ operation: 'set', field: 'service', value: 'installation' }],
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
    const outputPayload = contingency ? {
      schema: 'system_contingency_decision/v3',
      decision_id: decisionId,
      expected_snapshot_digest: snapshotDigest,
      reply: { text: replyText, sha256: `reply-${suffix}`, delivery_key: deliveryKey },
      mutations: [],
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
      schema: 'validated_conversation_decision/v3',
      decision_id: decisionId,
      expected_snapshot_digest: snapshotDigest,
      reply: { text: replyText, sha256: `reply-${suffix}`, delivery_key: deliveryKey },
      mutations,
      effect_commands: effectCommands,
    };
    const advisor = await client.query(`
      INSERT INTO advisor_decisions (
        conversation_id, decision_type, input_payload, output_payload,
        validation_result
      ) VALUES ($1, 'v3_conversation_decision', $2::jsonb, $3::jsonb, 'accepted')
      RETURNING id
    `, [conversation.id, { policy_digest: `policy-${suffix}` }, outputPayload]);

    const routed = await client.query(routeSql, [
      event.inboundEventId, conversation.id, 'enforce', 'test-rule', 1,
      snapshotDigest, qualification,
    ]);
    expect(routed.rows).toHaveLength(1);
    expect(routed.rows[0].route_acquired).toBe(true);

    const initialState = contingency
      ? 'prepared'
      : effectCommands.length > 0 ? 'effects_pending' : 'ready_to_commit';
    const prepared = await client.query(prepareSql, [
      event.inboundEventId, advisor.rows[0].id, decisionId, initialState,
      `policy-${suffix}`, `proposal-${suffix}`, `decision-digest-${suffix}`, deliveryKey,
    ]);
    expect(prepared.rows[0].decision_matches).toBe(true);

    return {
      conversationId: conversation.id,
      inboundEventId: event.inboundEventId,
      token: event.token,
      advisorDecisionId: advisor.rows[0].id,
      decisionId,
      deliveryKey,
      snapshotDigest,
      qualification,
      replyText,
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

  test('keeps preparation and the authorized decision immutable on replay', async () => {
    const turn = await seedTurn();
    const replay = await client.query(prepareSql, [
      turn.inboundEventId, turn.advisorDecisionId, turn.decisionId,
      'ready_to_commit', 'policy-turn-' + sequence, 'proposal-turn-' + sequence,
      'decision-digest-turn-' + sequence, turn.deliveryKey,
    ]);
    expect(replay.rows[0].decision_matches).toBe(true);

    const conflict = await client.query(prepareSql, [
      turn.inboundEventId, turn.advisorDecisionId, `${turn.decisionId}-changed`,
      'ready_to_commit', 'changed', 'changed', 'changed', `${turn.deliveryKey}-changed`,
    ]);
    expect(conflict.rows[0].decision_matches).toBe(false);
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

  test('records effect receipts and never retries an unknown outcome blindly', async () => {
    const effect = {
      type: 'quote_create', operation_key: `effect-${sequence + 1}`,
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

  test('requires recovery for inconclusive or duplicate exact-key reconciliation', async () => {
    for (const resolution of ['inconclusive', 'duplicate']) {
      const effect = {
        type: 'quote_create', operation_key: `effect-${resolution}-${sequence + 1}`,
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
      type: 'quote_create', operation_key: `effect-noop-${sequence + 1}`,
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
  test('stores one delivery receipt through the legal terminal transition', async () => {
    const turn = await seedTurn({ mutations: [] });
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
