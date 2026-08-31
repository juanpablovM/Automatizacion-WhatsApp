import fs from 'node:fs';
import { describe, expect, test } from 'vitest';

const fixturePath = 'tests/fixtures/workflow-nodes/wa-conversation-orchestrator/prepare-v3-saga-result.js';

// Run the node the way n8n runs it: the source ends in a top-level return, so it
// is executed as a function body, never imported. Importing it is a parse error,
// which is why every other fixture test uses this shape too.
const runCodeNode = (items, context) => {
  const source = fs.readFileSync(fixturePath, 'utf8');
  const $ = () => ({ first: () => ({ json: context }) });
  return new Function('items', '$', source)(items, $);
};

// Prepare Conversation Output reads 77 fields off the row. The v3 saga runs
// entirely through Postgres nodes, and an n8n Postgres node replaces the item
// with its query result, so by the end of the lane the turn context is gone.
// These are the fields whose loss made a v3 turn reach the dispatcher with no
// dispatch contract: no reply, no handoff, no follow-up.
const turnContext = {
  phone_number: '56900000000',
  processing_token: 'tok-1',
  inbound_event_id: 42,
  conversation_id: 150,
  source_number_id: 7,
  instance_name: 'wahormiglass',
  escalation_area: 'b2b',
  commercial_missing_fields: ['product'],
};

describe('Prepare V3 Saga Result rejoins the saga with the turn context', () => {
  test('restores the turn context the Postgres nodes replaced', () => {
    const [out] = runCodeNode([{ json: { decision_id: 'd-1', state: 'delivered' } }], turnContext);

    expect(out.json.phone_number).toBe('56900000000');
    expect(out.json.processing_token).toBe('tok-1');
    expect(out.json.inbound_event_id).toBe(42);
    expect(out.json.escalation_area).toBe('b2b');
    expect(out.json.v3_saga).toBe(true);
  });

  test('ledger state wins where both sides define a field', () => {
    const [out] = runCodeNode([{ json: { conversation_id: 999, state: 'delivered' } }], turnContext);

    expect(out.json.conversation_id).toBe(999);
    expect(out.json.state).toBe('delivered');
  });

  test('maps the durable v3 outbox row to the downstream delivery contract', () => {
    const [out] = runCodeNode([{ json: {
      decision_id: 'decision-v3-1',
      delivery_key: 'v3-delivery:exact',
      delivery_message_id: 901,
      text_body: 'Respuesta autorizada',
      raw_payload: { reply_sha256: 'sha256-exact' },
      state: 'delivery_pending',
    } }], {
      ...turnContext,
      should_create_lead: true,
      should_escalate: true,
    });

    expect(out.json).toMatchObject({
      response_text: 'Respuesta autorizada',
      message_id: 901,
      delivery_key: 'v3-delivery:exact',
      decision_id: 'decision-v3-1',
      reply_sha256: 'sha256-exact',
      should_create_lead: false,
      should_escalate: false,
    });
  });

  test('an empty saga still emits one turn instead of losing it', () => {
    // Emitting nothing is exactly how the lane used to drop items in silence.
    const out = runCodeNode([], turnContext);

    expect(out).toHaveLength(1);
    expect(out[0].json.phone_number).toBe('56900000000');
    expect(out[0].json.v3_saga_empty).toBe(true);
  });

  test('every saga row becomes one output row', () => {
    const out = runCodeNode(
      [{ json: { decision_id: 'a' } }, { json: { decision_id: 'b' } }],
      turnContext,
    );

    expect(out.map((item) => item.json.decision_id)).toEqual(['a', 'b']);
    expect(out.every((item) => item.json.phone_number === '56900000000')).toBe(true);
  });

  test('an unreachable context never throws: the turn still carries the saga row', () => {
    const source = fs.readFileSync(fixturePath, 'utf8');
    const throwing = () => { throw new Error('node not in this execution path'); };
    const [out] = new Function('items', '$', source)([{ json: { decision_id: 'd-2' } }], throwing);

    expect(out.json.decision_id).toBe('d-2');
    expect(out.json.v3_saga).toBe(true);
  });
});
