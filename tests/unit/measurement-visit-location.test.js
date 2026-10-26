import fs from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';
import { evaluateConversationStep } from '../fixtures/workflow-nodes/wa-conversation-orchestrator/evaluate-conversation-step.js';

// -----------------------------------------------------------------------------
// Task 3c.33 (M5, live 2026-09-30, conversation 391): "No lo sé. Pueden medir
// ustedes?" escalated at once, before the commune and address, with internal
// copy ("sin asumir una cantidad ni confirmar una visita") and a handoff that
// carried no location. The legacy measurement-assistance rule now collects the
// commune (validated against the official list) and the address first, keeps
// whatever is already known, and then hands off with both in the context.
// -----------------------------------------------------------------------------

const require = createRequire(import.meta.url);
const root = 'tests/fixtures/workflow-nodes/';
const code = (path, row, env = {}) => new Function('items', '$env', fs.readFileSync(root + path, 'utf8'))([{ json: row }], env)[0].json;
const apply = (deterministic) => code('wa-conversation-orchestrator/apply-ai-assistance.js', {
  ...deterministic,
  ...Object.fromEntries(Object.entries(deterministic).map(([key, value]) => [key + '_1', value])),
});
const base = {
  phone_number: 'synthetic-measure', conversation_id: 391, target_conversation_id: 391,
  has_existing_conversation: true, has_active_conversation: true, is_recent_conversation: true,
  is_stale_context: false, is_reengagement: false, conversation_status_code: 'waiting_user',
  current_step: 'quantity', message_type: 'text', pending_question_key: 'quantity',
  qualification_context: { product: 'Adoquín', line_items: [{ item_id: 'li_a', product: 'Adoquín', quantity: null, measurements: null }] },
};
const evaluate = (text, extra = {}) => evaluateConversationStep({ ...base, ...extra, text_body: text }).json;
const INTERNAL_COPY = /sin asumir|confirmar una visita/;

describe('measurement assistance collects the location before the handoff (M5)', () => {
  test('without a commune it asks the commune instead of escalating', () => {
    const out = evaluate('No lo sé. Pueden medir ustedes?');
    expect(out.should_escalate).toBe(false);
    expect(out.response_kind).toBe('measurement_visit_location');
    expect(out.pending_question_key).toBe('measurement_visit_commune');
    expect(out.v3_control_only).toBe(true);
    expect(out.deterministic_reply).toMatch(/comuna/);
    expect(out.deterministic_reply).not.toMatch(INTERNAL_COPY);
    expect(out.deterministic_reply.split('\n').at(-1)).toMatch(/\?$/);

    const applied = apply(out);
    expect(applied.response_text).toBe(out.deterministic_reply);
    expect(applied.should_escalate).toBe(false);
    expect(applied.pending_question_key).toBe('measurement_visit_commune');
  });

  test('a valid commune is stored with its official name and the address is asked next', () => {
    const out = evaluate('puente alto', { pending_question_key: 'measurement_visit_commune' });
    expect(out.should_escalate).toBe(false);
    expect(out.pending_question_key).toBe('measurement_visit_address');
    expect(out.qualification_context.commune).toBe('Puente Alto');
    expect(out.deterministic_reply).toMatch(/calle/);
    const applied = apply(out);
    expect(applied.qualification_context.commune).toBe('Puente Alto');
    expect(JSON.parse(applied.qualification_context_json).commune).toBe('Puente Alto');
    expect(applied.response_text).toBe(out.deterministic_reply);
  });

  test('a province is not a commune: the commune is asked once more', () => {
    const out = evaluate('Chiloé', { pending_question_key: 'measurement_visit_commune' });
    expect(out.should_escalate).toBe(false);
    expect(out.pending_question_key).toBe('measurement_visit_commune_retry');
    expect(out.qualification_context.commune).toBeUndefined();
    expect(out.deterministic_reply).toMatch(/comuna/);
  });

  test('a second unrecognized answer still hands off, keeping the text as a location note', () => {
    const out = evaluate('Chiloé nomás', { pending_question_key: 'measurement_visit_commune_retry' });
    expect(out.pending_question_key).toBe('measurement_visit_address');
    expect(out.qualification_context.commune).toBeUndefined();
    expect(out.qualification_context.location_note).toBe('Chiloé nomás');
  });

  test('the address completes the location and hands off with it', () => {
    const out = evaluate('Aragón 134', {
      pending_question_key: 'measurement_visit_address',
      qualification_context: { ...base.qualification_context, commune: 'Puente Alto' },
    });
    expect(out.should_escalate).toBe(true);
    expect(out.escalation_reason).toBe('measurement_assistance_requested');
    expect(out.qualification_context.address).toBe('Aragón 134');
    expect(out.deterministic_reply).toContain('Aragón 134, Puente Alto');
    expect(out.deterministic_reply).not.toMatch(INTERNAL_COPY);
    const applied = apply(out);
    expect(applied.should_escalate).toBe(true);
    expect(applied.response_text).toBe(out.deterministic_reply);
    expect(applied.qualification_context.address).toBe('Aragón 134');
  });

  test('with commune and address already known it hands off at once with friendly copy', () => {
    const out = evaluate('Pueden venir a medir uds', {
      qualification_context: { ...base.qualification_context, commune: 'Colina', address: 'Calle Uno 100' },
    });
    expect(out.should_escalate).toBe(true);
    expect(out.escalation_reason).toBe('measurement_assistance_requested');
    expect(out.deterministic_reply).toContain('Calle Uno 100, Colina');
    expect(out.deterministic_reply).not.toMatch(INTERNAL_COPY);
  });

  test('a known commune skips straight to the address', () => {
    const out = evaluate('no tengo las medidas', { qualification_context: { ...base.qualification_context, commune: 'Colina' } });
    expect(out.should_escalate).toBe(false);
    expect(out.pending_question_key).toBe('measurement_visit_address');
  });

  // Live conversation 541 (2026-10-20): "Necesito que alguien venga a medir mi
  // patio para instalar baldosas" opened the conversation. The rule only ran
  // after a quantity or measurements question and only matched "pueden/podría
  // ... medir", so v3.1 asked the tile type three times instead.
  const fresh = {
    phone_number: 'synthetic-measure', message_type: 'text',
    has_existing_conversation: false, has_active_conversation: false, qualification_context: {},
  };
  const evaluateFresh = (text) => evaluateConversationStep({ ...fresh, text_body: text }).json;

  test.each([
    'Necesito que alguien venga a medir mi patio para instalar baldosas',
    'Pueden venir a medir mi patio?',
    '¿Podrían ir a tomar las medidas de la terraza?',
    'Quiero una visita para medir el terreno',
    'Necesito que vengan a medir',
    'Alguien que me mida el patio, por favor',
  ])('an explicit measurement visit request opens the visit flow on the first message: %s', (text) => {
    const out = evaluateFresh(text);
    expect(out.response_kind).toBe('measurement_visit_location');
    expect(out.pending_question_key).toBe('measurement_visit_commune');
    expect(out.v3_control_only).toBe(true);
    expect(out.should_escalate).toBe(false);
    expect(out.deterministic_reply).toMatch(/^¡Hola! 👋 Te damos la bienvenida a \*Hormiglass\*, soy Hormi Atención\.\n\n/);
    expect(out.deterministic_reply).toMatch(/comuna/);
  });

  test('an explicit measurement visit request mid-quote opens the flow without a welcome', () => {
    const out = evaluate('Necesito que alguien venga a medir', { pending_question_key: 'service_scope', current_step: 'service_scope' });
    expect(out.response_kind).toBe('measurement_visit_location');
    expect(out.deterministic_reply).not.toMatch(/bienvenida/);
  });

  test.each([
    'Las medidas del patio son 5 por 4 metros',
    'Quiero 100 baldosas, ya medí el patio',
    '¿Cómo mido mi patio?',
    'No sé',
    'Voy a ir a medir el patio y les aviso',
    'Después de la visita del maestro les mando las medidas',
  ])('a message that does not ask for someone to measure stays with the advisor: %s', (text) => {
    expect(evaluateFresh(text).response_kind).not.toBe('measurement_visit_location');
  });

  test('human ownership still suppresses the flow', () => {
    const out = evaluate('Pueden medir ustedes?', { bot_suppressed: true });
    expect(out.deterministic_reply).toBe('');
    expect(out.should_escalate).toBe(false);
  });
});

describe('the handoff task carries the project location (M5)', () => {
  const { prepareHandoffClickup } = require('../fixtures/workflow-nodes/ops-handoff-notification-scheduler/prepare-handoff-clickup-task.js');
  const env = { CLICKUP_API_TOKEN: 'token', CLICKUP_HANDOFF_LIST_ID: 'list', HANDOFF_CLICKUP_ASSIGNEES_JSON: '{"sales":[1]}' };

  test('product, commune and address appear in the description', () => {
    const out = prepareHandoffClickup({
      handoff_id: 7, operation_key: 'handoff-clickup:7', area: 'sales', area_label: 'Ventas', motivo: 'sales',
      escalation_reason: 'measurement_assistance_requested',
      project_product: 'Adoquín', project_commune: 'Puente Alto', project_address: 'Aragón 134',
    }, env);
    expect(out.clickup_payload.description).toContain('Producto: Adoquín');
    expect(out.clickup_payload.description).toContain('Comuna: Puente Alto');
    expect(out.clickup_payload.description).toContain('Dirección: Aragón 134');
  });

  test('a handoff without location data keeps the previous description', () => {
    const out = prepareHandoffClickup({ handoff_id: 7, operation_key: 'k', area: 'sales' }, env);
    expect(out.clickup_payload.description).not.toMatch(/Comuna:|Dirección:|Producto:/);
  });
});
