import fs from 'node:fs';
import { describe, expect, test } from 'vitest';

const fixturePath = 'tests/fixtures/workflow-nodes/wa-inbound-entry/normalize-evolution-payload.js';
const source = fs.readFileSync(fixturePath, 'utf8');

const run = (body, env = { EVOLUTION_WEBHOOK_SECRET: 'secret' }, headers = {}) =>
  new Function('items', '$env', source)([
    { json: { body, headers: { 'x-evolution-webhook-secret': 'secret', ...headers } } },
  ], env)[0].json;

const message = ({ fromMe = false, id = 'wamid-1', remoteJid = '56911111111@s.whatsapp.net' } = {}) => ({
  event: 'messages.upsert',
  instance: 'sales-number',
  data: {
    key: { id, fromMe, remoteJid },
    messageTimestamp: 1_789_000_000,
    message: { conversation: 'Hola' },
  },
});

describe('Normalize Evolution Payload — own-message evidence', () => {
  test('keeps customer messages processable and marks their candidate origin', () => {
    const output = run(message());

    expect(output.should_process).toBe(true);
    expect(output.is_from_me).toBe(false);
    expect(output.sender_type_candidate).toBe('customer');
    expect(output.external_message_id).toBe('wamid-1');
  });

  test('keeps fromMe events processable for database-backed classification', () => {
    const output = run(message({ fromMe: true, id: 'own-1' }));

    expect(output.should_process).toBe(true);
    expect(output.is_from_me).toBe(true);
    expect(output.sender_type_candidate).toBe('own_message');
    expect(output.external_message_id).toBe('own-1');
  });

  test('still ignores group messages even when they are fromMe', () => {
    const output = run(message({ fromMe: true, remoteJid: '120363000000@g.us' }));

    expect(output.should_process).toBe(false);
    expect(output.normalized_event).toBe('MESSAGES_UPSERT');
  });

  test('still rejects a webhook with the wrong secret before parsing it', () => {
    const output = run(message(), { EVOLUTION_WEBHOOK_SECRET: 'expected' });

    expect(output.should_process).toBe(false);
    expect(output.security_rejected).toBe(true);
    expect(output.normalized_event).toBe('SECURITY_REJECTED');
  });
});
