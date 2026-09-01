// The v3 policy compiles its grounding authority from the commercial catalog,
// and `Load Conversation State` is the only node that runs before it. That query
// never returned a catalog, so `grounding.catalog` was always empty — and with
// no grounding entry to match, no observation about a product, service or
// commune can validate. `create_lead` requires product, commune, quantity and
// modality resolved, so under v3 it was unreachable for any new contact: not a
// missing fixture, a policy compiled without the authority it needs.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const { buildV3PolicyInput } = require('../fixtures/workflow-nodes/shared/v3-rollout-runtime.js');
const { compileV3TurnPolicy, validateV3AiProposal } = require('../fixtures/workflow-nodes/shared/v3-contract-runtime.js');

const enabled = process.env.TEST_PG_INTEGRATION === '1';
const describeIntegration = enabled ? describe : describe.skip;
const connection = {
  host: process.env.TEST_PGHOST || '127.0.0.1',
  port: Number(process.env.TEST_PGPORT || 55433),
  database: process.env.TEST_PGDATABASE || 'testdb',
  user: process.env.TEST_PGUSER || 'test',
  password: process.env.TEST_PGPASSWORD || 'test',
};
const loadSql = fs.readFileSync(
  'db/queries/n8n/wa-conversation-orchestrator/01_load_active_context.sql',
  'utf8',
);

const PHONE = '15550009999';
const TOKEN = 'grounding-token-1';
const MESSAGE = 'Necesito 20 m3 de hormigon H25 en Santiago con delivery';

describeIntegration('v3 policy grounding authority', () => {
  const client = new pg.Client(connection);
  let sourceNumberId;
  let inboundEventId;

  beforeAll(async () => {
    await client.connect();
    await client.query('BEGIN');

    const number = await client.query(
      `INSERT INTO whatsapp_numbers (phone_number_id, instance_name, display_name, phone_number, is_active)
       VALUES ('synthetic-grounding', 'grounding-instance', 'Grounding', $1, TRUE) RETURNING id`,
      [PHONE],
    );
    sourceNumberId = number.rows[0].id;

    await client.query(
      `INSERT INTO catalog_items (sku, name, item_type, applicable_cities, is_active)
       VALUES ('H25', 'hormigon H25', 'product', ARRAY['Santiago'], TRUE),
              ('BOMBEO', 'bombeo de hormigon', 'service', ARRAY['Santiago'], TRUE),
              ('OLD', 'producto retirado', 'product', ARRAY['Santiago'], FALSE)`,
    );

    const event = await client.query(
      `INSERT INTO inbound_events (
         source_number_id, phone_number, external_message_id, instance_name,
         event_fingerprint, dedupe_key, queue_key, event_type,
         raw_payload, processing_status, processing_token
       ) VALUES ($1, $2, 'grounding-msg-1', 'grounding-instance',
                 'grounding-fingerprint-1', 'grounding-dedupe-1', $2, 'messages.upsert',
                 '{}'::jsonb, 'processing', $3)
       RETURNING id`,
      [sourceNumberId, PHONE, TOKEN],
    );
    inboundEventId = event.rows[0].id;
  });

  afterAll(async () => {
    if (enabled) {
      await client.query('ROLLBACK');
      await client.end();
    }
  });

  const loadRow = async () => {
    const result = await client.query(loadSql, [
      PHONE, String(sourceNumberId), 'Cliente Grounding', '', 'grounding-msg-1', '',
      'text', MESSAGE, '{}', '', '', '', '', '', '', '',
      'grounding-instance', String(inboundEventId), TOKEN,
    ]);
    return result.rows[0];
  };

  test('publishes the active catalog as grounding entries', async () => {
    const row = await loadRow();
    const catalog = row.v3_grounding?.catalog || [];

    expect(catalog).toContainEqual({ ref: 'product:H25', concept: 'product', value: 'hormigon H25' });
    expect(catalog).toContainEqual({ ref: 'service:BOMBEO', concept: 'service', value: 'bombeo de hormigon' });
    expect(catalog).toContainEqual({ ref: 'commune:santiago', concept: 'commune', value: 'Santiago' });

    // A retired item must not authorize claims about itself.
    expect(catalog.map(({ value }) => value)).not.toContain('producto retirado');
  });

  test('lets an evidenced product observation validate against the compiled policy', async () => {
    const row = await loadRow();
    const policy = compileV3TurnPolicy(buildV3PolicyInput(row));

    const validation = validateV3AiProposal(policy, {
      version: 'ai_conversation_proposal/v3',
      policy_digest: policy.policy_digest,
      reply_text: 'Tomo nota de hormigon H25 para Santiago.',
      primary_request: null,
      observations: [{
        id: 'obs-product',
        concept: 'product',
        raw_value: 'hormigon H25',
        normalized_value: 'hormigon H25',
        evidence_quote: 'hormigon H25',
        evidence_occurrence: 1,
        grounding_ref: 'product:H25',
        resolves_goal_ids: ['product'],
      }],
      state_mutations: [],
      effect_requests: [],
    });

    expect(validation.errors).toEqual([]);
    expect(validation.accepted_observations).toHaveLength(1);
  });

  test('still rejects a product the catalog does not carry', async () => {
    const row = await loadRow();
    const policy = compileV3TurnPolicy(buildV3PolicyInput(row));

    const validation = validateV3AiProposal(policy, {
      version: 'ai_conversation_proposal/v3',
      policy_digest: policy.policy_digest,
      reply_text: 'Tomo nota.',
      primary_request: null,
      observations: [{
        id: 'obs-invented',
        concept: 'product',
        raw_value: 'hormigon H25',
        normalized_value: 'hormigon H99 premium',
        evidence_quote: 'hormigon H25',
        evidence_occurrence: 1,
        grounding_ref: 'product:H99',
        resolves_goal_ids: ['product'],
      }],
      state_mutations: [],
      effect_requests: [],
    });

    expect(validation.valid).toBe(false);
    expect(validation.errors.map(({ code }) => code)).toContain('grounding_invalid');
  });
});
