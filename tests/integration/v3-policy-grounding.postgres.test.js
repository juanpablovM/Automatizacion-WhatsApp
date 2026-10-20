// The v3 policy compiles its grounding authority from the commercial catalog,
// and `Load Conversation State` is the only node that runs before it. That query
// never returned a catalog, so `grounding.catalog` was always empty — and with
// no grounding entry to match, no observation about a product or service can
// validate. Commune is deliberately evidence-backed free text because item
// coverage cities are not an exhaustive municipality catalog. Under v3 the
// missing product authority made create_lead unreachable for any new contact: not a
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

const PHONE = '15550009888';
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
    // Task 3c.19: synonyms live in metadata.synonyms (migration 026).
    await client.query(
      `INSERT INTO catalog_items (sku, name, item_type, applicable_cities, is_active, metadata)
       VALUES ('BLQ', 'Bloques de Hormigón', 'product', ARRAY['Santiago'], TRUE,
               '{"url": "https://example.test/bloques", "synonyms": ["bloques de cemento"]}'::jsonb),
              ('EMPTY-SYN', 'producto sin sinonimos', 'product', ARRAY['Santiago'], TRUE,
               '{"synonyms": []}'::jsonb),
              ('BAD-SYN', 'producto con sinonimos invalidos', 'product', ARRAY['Santiago'], TRUE,
               '{"synonyms": "bloque"}'::jsonb)`,
    );
    // Task 3c.20: technical sheets live in metadata.technical_sheet (private data, scripts/catalog/technical-sheets.mjs).
    await client.query(
      `INSERT INTO catalog_items (sku, name, item_type, applicable_cities, is_active, metadata)
       VALUES ('SHEET', 'producto con ficha', 'product', ARRAY['Santiago'], TRUE,
               '{"technical_sheet": {"description": "Ficha de prueba.", "general_specs": {}, "variants": [{"name": "Variante A", "code": null, "dimensions": "10x20 cm", "weight": "5 kg", "yield": null, "resistance": null, "colors": [], "finishes": [], "other": {}}], "unconfirmed": {}, "source_files": ["ficha privada.pdf"]}}'::jsonb),
              ('BAD-SHEET', 'producto con ficha invalida', 'product', ARRAY['Santiago'], TRUE,
               '{"technical_sheet": "texto"}'::jsonb)`,
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
    expect(catalog.some(({ concept }) => concept === 'commune')).toBe(false);

    // A retired item must not authorize claims about itself.
    expect(catalog.map(({ value }) => value)).not.toContain('producto retirado');
  });

  test('forwards non-empty metadata.synonyms and keeps every other entry shape unchanged', async () => {
    const row = await loadRow();
    const catalog = row.v3_grounding?.catalog || [];

    expect(catalog).toContainEqual({
      ref: 'product:BLQ', concept: 'product', value: 'Bloques de Hormigón', synonyms: ['bloques de cemento'],
    });
    expect(catalog).toContainEqual({ ref: 'product:EMPTY-SYN', concept: 'product', value: 'producto sin sinonimos' });
    expect(catalog).toContainEqual({ ref: 'product:BAD-SYN', concept: 'product', value: 'producto con sinonimos invalidos' });
  });

  test('synonyms reach the v3.1 policy grounding but never the v3 one', async () => {
    const row = await loadRow();
    const v31 = compileV3TurnPolicy(buildV3PolicyInput(row, { version: 'v3.1' }));
    const v3 = compileV3TurnPolicy(buildV3PolicyInput(row));

    expect(v31.grounding.catalog.find((entry) => entry.ref === 'product:BLQ').synonyms).toEqual(['bloques de cemento']);
    expect(v3.grounding.catalog.find((entry) => entry.ref === 'product:BLQ')).toEqual({
      ref: 'product:BLQ', concept: 'product', value: 'Bloques de Hormigón',
    });
  });

  test('forwards metadata.technical_sheet objects without their source_files', async () => {
    const row = await loadRow();
    const catalog = row.v3_grounding?.catalog || [];
    const sheetEntry = catalog.find((entry) => entry.ref === 'product:SHEET');

    expect(sheetEntry.technical_sheet).toEqual({
      description: 'Ficha de prueba.',
      general_specs: {},
      variants: [{
        name: 'Variante A', code: null, dimensions: '10x20 cm', weight: '5 kg', yield: null, resistance: null, colors: [], finishes: [], other: {},
      }],
      unconfirmed: {},
    });
    expect(catalog).toContainEqual({ ref: 'product:BAD-SHEET', concept: 'product', value: 'producto con ficha invalida' });
  });

  test('a technical sheet reaches the v3.1 policy only when the turn names the product, never the v3 one', async () => {
    const row = await loadRow();
    const naming = { ...row, text_body: '¿Cuánto pesa el producto con ficha?' };
    const sheetOf = (policy) => policy.grounding.catalog.find((entry) => entry.ref === 'product:SHEET').technical_sheet;

    expect(sheetOf(compileV3TurnPolicy(buildV3PolicyInput(naming, { version: 'v3.1' })))).toEqual({
      description: 'Ficha de prueba.',
      variants: [{ name: 'Variante A', dimensions: '10x20 cm', weight: '5 kg' }],
    });
    expect(sheetOf(compileV3TurnPolicy(buildV3PolicyInput(row, { version: 'v3.1' })))).toBeUndefined();
    expect(sheetOf(compileV3TurnPolicy(buildV3PolicyInput(naming)))).toBeUndefined();
  });

  test('lets an evidenced product observation validate against the compiled policy', async () => {
    const row = await loadRow();
    const policy = compileV3TurnPolicy(buildV3PolicyInput(row));

    const validation = validateV3AiProposal(policy, {
      version: 'ai_conversation_proposal/v3',
      policy_digest: policy.policy_digest,
      reply_text: 'Tomo nota de hormigon H25 para Santiago.',
      primary_request: null,
      catalog_resolution: {
        status: 'matched', evidence_quote: 'hormigon H25', evidence_occurrence: 1,
        grounding_ref: 'product:H25',
      },
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

  test('keeps an evidenced commune exactly even when it is absent from item coverage', async () => {
    const row = await loadRow();
    const message = 'El despacho es en Peñalolén';
    const policy = compileV3TurnPolicy(buildV3PolicyInput({
      ...row,
      text_body: message,
      qualification_context: {},
    }));

    const validation = validateV3AiProposal(policy, {
      version: 'ai_conversation_proposal/v3',
      policy_digest: policy.policy_digest,
      reply_text: 'Perfecto, registré Peñalolén.',
      primary_request: null,
      catalog_resolution: {
        status: 'not_applicable', evidence_quote: null, evidence_occurrence: null,
        grounding_ref: null,
      },
      observations: [{
        id: 'obs-commune', concept: 'commune', raw_value: 'Peñalolén',
        normalized_value: 'Peñalolén', evidence_quote: 'Peñalolén', evidence_occurrence: 1,
        grounding_ref: null, resolves_goal_ids: ['commune'],
      }],
      state_mutations: [{
        operation: 'set', field: 'commune', observation_id: 'obs-commune', replaces_fact_id: null,
      }],
      effect_requests: [],
    });

    expect(validation.errors).toEqual([]);
    expect(validation.authorized_mutations[0].projected_value).toBe('Peñalolén');
  });

  test('still rejects a product the catalog does not carry', async () => {
    const row = await loadRow();
    const policy = compileV3TurnPolicy(buildV3PolicyInput(row));

    const validation = validateV3AiProposal(policy, {
      version: 'ai_conversation_proposal/v3',
      policy_digest: policy.policy_digest,
      reply_text: 'Tomo nota.',
      primary_request: null,
      catalog_resolution: {
        status: 'matched', evidence_quote: 'hormigon H25', evidence_occurrence: 1,
        grounding_ref: 'product:H99',
      },
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
