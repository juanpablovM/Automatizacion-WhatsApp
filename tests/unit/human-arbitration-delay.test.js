import fs from 'node:fs';
import { afterEach, describe, expect, test, vi } from 'vitest';

const buildSource = fs.readFileSync(
  'tests/fixtures/workflow-nodes/wa-outbound-messages/build-outbound-payload.js',
  'utf8',
);
const delaySource = fs.readFileSync(
  'tests/fixtures/workflow-nodes/wa-outbound-messages/apply-human-arbitration-delay.js',
  'utf8',
);
const outboundWorkflow = JSON.parse(fs.readFileSync(
  'n8n/workflows/wa-outbound-messages.json',
  'utf8',
));
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

const outboundEnv = {
  EVOLUTION_API_BASE_URL: 'https://evolution.test',
  EVOLUTION_API_KEY: 'secret',
  EVOLUTION_DEFAULT_INSTANCE: 'sales',
};

afterEach(() => vi.useRealTimers());

describe('first bot turn after human SLA expiry', () => {
  test('propagates the arbitration requirement into the outbound claim', () => {
    const output = new Function('items', '$env', buildSource)([{
      json: {
        conversation_id: 12,
        phone_number: '56911111111',
        response_text: 'Hola nuevamente',
        human_arbitration_required: true,
      },
    }], outboundEnv);

    expect(output[0].json.human_arbitration_required).toBe(true);
  });

  test('waits exactly ten seconds only for the first resumed turn', async () => {
    vi.useFakeTimers();
    const runDelay = new AsyncFunction('items', '$env', delaySource);
    let completed = false;
    const pending = runDelay([{
      json: { should_send: true, human_arbitration_required: true },
    }], {}).then((value) => {
      completed = true;
      return value;
    });

    await vi.advanceTimersByTimeAsync(9_999);
    expect(completed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toHaveLength(1);
  });

  test('does not delay an ordinary bot turn', async () => {
    vi.useFakeTimers();
    const runDelay = new AsyncFunction('items', '$env', delaySource);
    const output = await runDelay([{
      json: { should_send: true, human_arbitration_required: false },
    }], {});

    expect(output).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  test('routes a final authority rejection away from Evolution', () => {
    expect(outboundWorkflow.connections['Mark Outbound Sending'].main[0][0].node)
      .toBe('Final Send Authorized');
    expect(outboundWorkflow.connections['Final Send Authorized'].main[0][0].node)
      .toBe('Send Evolution Message');
    expect(outboundWorkflow.connections['Final Send Authorized'].main[1][0].node)
      .toBe('Return Already Sent');
  });
});
