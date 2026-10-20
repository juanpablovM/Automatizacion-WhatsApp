// =============================================================================
// Inbound debounce configuration and the Code nodes that carry it.
// INBOUND_DEBOUNCE_SECONDS (default 6, 0 disables) is the sliding window a
// contact's queue must stay quiet before its pending messages become one turn;
// INBOUND_DEBOUNCE_MAX_WAIT_SECONDS (default 30) bounds how long a customer who
// keeps typing can defer that turn.
// =============================================================================
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const { resolveInboundDebounce } = require('../fixtures/workflow-nodes/shared/inbound-debounce-config.js');

const runtime = fs.readFileSync('tests/fixtures/workflow-nodes/shared/inbound-debounce-config.js', 'utf8');
const codeNode = (fixture) => {
  const source = `${runtime}\n\n${fs.readFileSync(`tests/fixtures/workflow-nodes/${fixture}`, 'utf8')}`;
  return (items, env = {}) => new Function('items', '$env', source)(items, env);
};

describe('resolveInboundDebounce', () => {
  test('defaults to a 6 second window bounded at 30 seconds', () => {
    expect(resolveInboundDebounce({})).toEqual({ seconds: 6, max_wait_seconds: 30 });
    expect(resolveInboundDebounce(undefined)).toEqual({ seconds: 6, max_wait_seconds: 30 });
    expect(resolveInboundDebounce({ INBOUND_DEBOUNCE_SECONDS: '  ' })).toEqual({ seconds: 6, max_wait_seconds: 30 });
  });

  test('0 disables debouncing entirely', () => {
    expect(resolveInboundDebounce({ INBOUND_DEBOUNCE_SECONDS: '0' })).toEqual({ seconds: 0, max_wait_seconds: 0 });
  });

  test('reads whole seconds and caps the window at 60', () => {
    expect(resolveInboundDebounce({ INBOUND_DEBOUNCE_SECONDS: '10' }).seconds).toBe(10);
    expect(resolveInboundDebounce({ INBOUND_DEBOUNCE_SECONDS: '600' }).seconds).toBe(60);
  });

  test('an unreadable value keeps the default instead of disabling', () => {
    expect(resolveInboundDebounce({ INBOUND_DEBOUNCE_SECONDS: 'six' }).seconds).toBe(6);
    expect(resolveInboundDebounce({ INBOUND_DEBOUNCE_SECONDS: '-1' }).seconds).toBe(6);
    expect(resolveInboundDebounce({ INBOUND_DEBOUNCE_SECONDS: '2.5' }).seconds).toBe(6);
  });

  test('the max wait is never shorter than the window and is capped at 300', () => {
    expect(resolveInboundDebounce({ INBOUND_DEBOUNCE_SECONDS: '40', INBOUND_DEBOUNCE_MAX_WAIT_SECONDS: '10' }))
      .toEqual({ seconds: 40, max_wait_seconds: 40 });
    expect(resolveInboundDebounce({ INBOUND_DEBOUNCE_MAX_WAIT_SECONDS: '9999' }).max_wait_seconds).toBe(300);
    expect(resolveInboundDebounce({ INBOUND_DEBOUNCE_MAX_WAIT_SECONDS: '45' }).max_wait_seconds).toBe(45);
  });
});

describe('WA - Inbound Recovery :: Load Recovery Configuration', () => {
  const run = codeNode('wa-inbound-recovery/load-recovery-configuration.js');

  test('keeps the existing recovery knobs and adds the debounce window', () => {
    const [output] = run([{ json: {} }], {
      INBOUND_PROCESSING_STALE_SECONDS: '600',
      INBOUND_RECOVERY_BATCH_SIZE: '20',
      INBOUND_MAX_PROCESSING_ATTEMPTS: '5',
    });
    expect(output.json).toEqual({
      stale_seconds: 600,
      batch_size: 20,
      max_attempts: 5,
      debounce_seconds: 6,
      debounce_max_wait_seconds: 30,
      queue_scope_inbound_event_id: null,
    });
  });

  test('preserves the historical clamps of the recovery knobs', () => {
    const [output] = run([{ json: {} }], {
      INBOUND_PROCESSING_STALE_SECONDS: '5',
      INBOUND_RECOVERY_BATCH_SIZE: '500',
      INBOUND_MAX_PROCESSING_ATTEMPTS: '0',
    });
    expect(output.json).toMatchObject({ stale_seconds: 60, batch_size: 100, max_attempts: 1 });
  });

  test('a debounce waiter scopes the claim to its own contact queue', () => {
    const [output] = run([{ json: { queue_scope_inbound_event_id: '1891' } }], { INBOUND_DEBOUNCE_SECONDS: '6' });
    expect(output.json.queue_scope_inbound_event_id).toBe('1891');
  });

  test('the schedule and the dispatcher keep claiming every queue', () => {
    expect(run([{ json: { timestamp: '2026-10-13T14:38:00Z' } }])[0].json.queue_scope_inbound_event_id).toBeNull();
    expect(run([{ json: { completed_inbound_event_id: 1889 } }])[0].json.queue_scope_inbound_event_id).toBeNull();
    expect(run([{ json: { queue_scope_inbound_event_id: 'x; drop' } }])[0].json.queue_scope_inbound_event_id).toBeNull();
  });

  test('0 disables the window for every claim', () => {
    const [output] = run([{ json: {} }], { INBOUND_DEBOUNCE_SECONDS: '0' });
    expect(output.json).toMatchObject({ debounce_seconds: 0, debounce_max_wait_seconds: 0 });
  });
});

describe('WA - Inbound Entry :: Select Debounced Inbox Events', () => {
  const run = codeNode('wa-inbound-entry/select-debounced-inbox-events.js');

  test('schedules one drain per queued event, a little after its window closes', () => {
    const output = run([{ json: { inbound_event_id: 1891, debounce_pending: true, debounce_seconds: 6, duplicate_event: false } }]);
    expect(output).toEqual([{ json: { queue_scope_inbound_event_id: '1891', debounce_wait_seconds: 6.25 } }]);
  });

  test('nothing waits for an event claimed inline, a duplicate or a disabled window', () => {
    expect(run([
      { json: { inbound_event_id: 1, debounce_pending: false, debounce_seconds: 6 } },
      { json: { inbound_event_id: 2, debounce_pending: true, debounce_seconds: 6, duplicate_event: true } },
      { json: { inbound_event_id: 3, debounce_pending: true, debounce_seconds: 0 } },
      { json: { inbound_event_id: null, debounce_pending: true, debounce_seconds: 6 } },
      { json: { should_process: false } },
    ])).toEqual([]);
  });
});

describe('WA - Inbound Entry :: Normalize Evolution Payload', () => {
  const run = codeNode('wa-inbound-entry/normalize-evolution-payload.js');
  const body = {
    event: 'messages.upsert',
    instance: 'sales-number',
    data: {
      key: { id: 'wamid-1', fromMe: false, remoteJid: '56911111111@s.whatsapp.net' },
      messageTimestamp: 1_789_000_000,
      message: { conversation: 'Hola' },
    },
  };
  const normalize = (env) => run([{ json: { body, headers: {} } }], env)[0].json;

  test('hands the effective window to the durable inbox claim', () => {
    expect(normalize({}).inbound_debounce_seconds).toBe(6);
    expect(normalize({ INBOUND_DEBOUNCE_SECONDS: '0' }).inbound_debounce_seconds).toBe(0);
    expect(normalize({ INBOUND_DEBOUNCE_SECONDS: '8' }).inbound_debounce_seconds).toBe(8);
  });
});
