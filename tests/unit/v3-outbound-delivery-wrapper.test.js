import fs from 'node:fs';
import { describe, expect, test } from 'vitest';

const fixturePath = 'tests/fixtures/workflow-nodes/wa-outbound-messages/build-outbound-payload.js';
const normalizeFixturePath = 'tests/fixtures/workflow-nodes/wa-outbound-messages/normalize-delivery-result.js';
const alreadySentFixturePath = 'tests/fixtures/workflow-nodes/wa-outbound-messages/return-already-sent.js';
const sendFixturePath = 'tests/fixtures/workflow-nodes/wa-outbound-messages/send-evolution-message.js';

const runCodeNode = (row) => {
  const source = fs.readFileSync(fixturePath, 'utf8');
  const $env = {
    EVOLUTION_API_BASE_URL: 'http://evolution.test',
    EVOLUTION_API_KEY: 'test-key',
    EVOLUTION_DEFAULT_INSTANCE: 'default-instance',
  };
  return new Function('items', '$env', source)([{ json: row }], $env)[0].json;
};

const runNormalizeNode = (row) => {
  const source = fs.readFileSync(normalizeFixturePath, 'utf8');
  return new Function('items', source)([{ json: row }])[0].json;
};

describe('Build Outbound Payload v3 delivery identity', () => {
  test('uses the durable delivery_key verbatim instead of synthesizing evolution identity', () => {
    const result = runCodeNode({
      conversation_id: 44,
      phone_number: '56900000000',
      instance_name: 'wahormiglass',
      response_text: 'Respuesta autorizada',
      response_kind: 'v3_advisor_reply',
      message_id: 901,
      delivery_key: 'v3-delivery:exact',
    });

    expect(result.idempotency_key).toBe('v3-delivery:exact');
  });

  test('preserves an explicit legacy idempotency key when no delivery_key exists', () => {
    const result = runCodeNode({
      conversation_id: 45,
      phone_number: '56900000001',
      response_text: 'Mensaje legacy',
      idempotency_key: 'legacy:exact',
    });

    expect(result.idempotency_key).toBe('legacy:exact');
  });
});

describe('Normalize Delivery Result v3 terminal evidence', () => {
  test.each([
    [400, 'failed'],
    [0, 'unknown'],
  ])('quarantines a v3 %s provider outcome for reconciliation', (statusCode, status) => {
    const result = runNormalizeNode({
      id: 901,
      statusCode,
      body: { message: 'provider failure' },
      raw_payload: { version: 'validated_conversation_decision/v3' },
      idempotency_key: 'v3-delivery:exact',
    });

    expect(result.delivery_status).toBe(status);
    expect(result.reconciliation_required).toBe(true);
  });
});

describe('Return Already Sent v3 replay evidence', () => {
  test('exposes the stored provider id and exact delivery key without another send', () => {
    const source = fs.readFileSync(alreadySentFixturePath, 'utf8');
    const [result] = new Function('items', source)([{ json: {
      id: 901,
      already_sent: true,
      should_send: false,
      external_message_id: 'wamid-existing',
      idempotency_key: 'v3-delivery:exact',
    } }]);

    expect(result.json).toMatchObject({
      delivery_key: 'v3-delivery:exact',
      provider_external_message_id: 'wamid-existing',
      outbound_dispatch_status: 'already_sent',
    });
  });
});

describe('Send Evolution Message v3 replay boundary', () => {
  test('calls the provider once and suppresses the already-sent replay', async () => {
    const source = fs.readFileSync(sendFixturePath, 'utf8');
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    let providerCalls = 0;
    const helpers = {
      httpRequest: async () => {
        providerCalls += 1;
        return { statusCode: 200, body: { key: { id: 'wamid-once' } }, headers: {} };
      },
    };
    const run = (row) => new AsyncFunction('items', 'helpers', '$env', source)(
      [{ json: row }], helpers, { EVOLUTION_API_KEY: 'test-key' },
    );
    const operation = {
      should_send: true,
      already_sent: false,
      outbound_url: 'http://evolution.test/message/sendText/test',
      outbound_body: { number: '56900000000', text: 'Respuesta autorizada' },
    };

    const first = await run(operation);
    const replay = await run({ ...operation, should_send: false, already_sent: true });

    expect(first[0].json.body.key.id).toBe('wamid-once');
    expect(replay).toEqual([]);
    expect(providerCalls).toBe(1);
  });
});
