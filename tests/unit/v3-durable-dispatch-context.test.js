import fs from 'node:fs';
import { describe, expect, test } from 'vitest';

const source = fs.readFileSync('tests/fixtures/workflow-nodes/wa-inbound-downstream-dispatcher/outbound-lane-complete.js', 'utf8');
const runReceipt = (receipt, context) => new Function('items', '$', source)(
  [{ json: receipt }], () => ({ first: () => ({ json: context }) }),
)[0].json;

describe('v3 durable dispatch context', () => {
  test('restores the original inbox token after PostgreSQL delivery receipt replaces the item', () => {
    const output = runReceipt({ inbound_event_id: 44, state: 'delivered', delivery_receipt_ref: { provider_message_id: 'provider-1' } },
      { inbound_event_id: 44, processing_token: 'claim-44', phone_number: '15550004444', should_create_lead: false });
    expect(output).toMatchObject({ inbound_event_id: 44, processing_token: 'claim-44',
      state: 'delivered', phone_number: '15550004444', should_create_lead: false, outbound_lane_complete: true });
  });

  test('receipt columns cannot overwrite the original claimed event identity', () => {
    expect(runReceipt({ inbound_event_id: 999, processing_token: 'other' },
      { inbound_event_id: 44, processing_token: 'claim-44' })).toMatchObject({ inbound_event_id: 44, processing_token: 'claim-44' });
  });

  test('durable output unwraps exact stored JSON without reinterpreting the decision', () => {
    const outputSource = fs.readFileSync('tests/fixtures/workflow-nodes/wa-conversation-orchestrator/return-conversation-output.js', 'utf8');
    const payload = { inbound_event_id: 44, processing_token: 'claim-44', decision_id: 'decision-44', response_text: 'Exact reply bytes', v3_saga: true };
    const output = new Function('items', outputSource)([{ json: { dispatch_payload: payload } }]);
    expect(output).toEqual([{ json: payload }]);
    expect(new Function('items', outputSource)([{ json: payload }])).toEqual([{ json: payload }]);
  });
});
