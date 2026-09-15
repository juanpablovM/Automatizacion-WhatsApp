import fs from 'node:fs';
import { describe, expect, test } from 'vitest';

const fixtureRoot = 'tests/fixtures/workflow-nodes/';
const run = (name, row) => new Function('items', '$env', fs.readFileSync(fixtureRoot + name, 'utf8'))([{ json: row }], {})[0].json;
const transcript = JSON.parse(fs.readFileSync('tests/fixtures/commercial-capture-provider-transcript.json', 'utf8'));
const base = {
  current_step: 'confirm', conversation_status_code: 'waiting_user', pending_question_key: 'quantity',
  service: 'Baldosas', city: 'San Bernardo', requirement: 'Obra, necesito solo material. Son 1000 unidades',
  qualification_context: { product: 'Baldosas', modality: 'delivery', commune: 'San Bernardo' },
  should_create_lead: false, should_escalate: false, has_intent: true, response_kind: 'question',
};
const turn = (text, model = {}, extra = {}, status = 200) => {
  const deterministic = { ...base, ...extra, text_body: text, normalized_text: text };
  const normalized = run('ai-lead-qualification-assistant/normalize-ai-result.js', {
    ai_context: { message_current: text, existing_fields: { service: deterministic.service, city: deterministic.city, requirement: deterministic.requirement }, pending_question_key: deterministic.pending_question_key },
    ai_status_code: status,
    ai_response: { choices: [{ message: { content: JSON.stringify({ intent: 'provide_info', confidence: 0.95, ...model }) } }] },
  });
  return run('wa-conversation-orchestrator/apply-ai-assistance.js', {
    ...normalized, ...Object.fromEntries(Object.entries(deterministic).map(([key, value]) => [key + '_1', value])),
  });
};

describe('commercial capture recovery — provider contract regressions', () => {
  test.each(transcript)('actual provider shape does not drop quantity or repeat quantity question: $message', ({ message, model }) => {
    const out = turn(message, model, { qualification_context: { product: 'Pastelones', modality: 'delivery' } });
    if (/1000/.test(message)) {
      expect(out.qualification_context.quantity).toBe('1000 unidades');
      expect(out.pending_question_key).toBe('address');
      expect(out.response_text).not.toMatch(/cantidad aproximada/);
    }
    expect(out.service).toBe('Pastelones');
    expect(out.executive_summary).toContain('Producto: Pastelones');
    expect(out.should_create_lead).toBe(false);
  });

  test('current literal commune replaces old commune without magic intent flags', () => {
    const out = turn(transcript[0].message, transcript[0].model);
    expect(out.city).toBe('Las Condes');
    expect(out.qualification_context.commune).toBe('Las Condes');
    expect(out.requirement).toBe('1000 pastelones');
  });

  test('inherited AI commune cannot overwrite when current text contains only quantity', () => {
    const out = turn('Necesito 1000 unidades', { city: 'Las Condes', explicitly_mentioned_fields: ['city'], field_updates: { commune: 'Las Condes' } });
    expect(out.city).toBe('San Bernardo');
    expect(out.qualification_context.commune).toBe('San Bernardo');
  });

  test.each(['1000 pastelones', 'Necesito 1000 unidades', '649 pastelones', 'Necesito 1.000 unidades'])('explicit count survives omitted model field: %s', (text) => {
    const out = turn(text);
    expect(out.qualification_context.quantity).toBe(text.includes('649') ? '649 unidades' : text.includes('1.000') ? '1.000 unidades' : '1000 unidades');
    expect(out.pending_question_key).toBe('address');
    expect(out.should_create_lead).toBe(false);
  });

  test('explicit count survives provider unavailable without reading summaries', () => {
    const out = turn('Necesito 649 pastelones', {}, {}, 503);
    expect(out.qualification_context.quantity).toBe('649 unidades');
    expect(out.pending_question_key).toBe('address');
    expect(out.should_create_lead).toBe(false);
  });

  test('new count correction removes conflicting old measurements', () => {
    const out = turn('No son 56m2, son 1000 unidades', { intent: 'correction' }, { qualification_context: { product: 'Pastelones', modality: 'delivery', measurements: '56m2' } });
    expect(out.qualification_context.quantity).toBe('1000 unidades');
    expect(out.qualification_context.measurements).toBeUndefined();
    expect(out.executive_summary).toContain('Cantidad/medidas: 1000 unidades');
  });

  test.each(['Pastelones 50x50', 'Pastelones 50x50cm', 'SKU 649 pastelones', 'Código 649 pastelones', 'Mi RUT es 12.345.649-0', 'Dirección calle 649 Pastelones', 'Tengo 20 pastelones actualmente para retirar', 'No necesito 1000 pastelones', 'Necesito -1000 unidades'])('does not confuse non-requested numbers with count: %s', (text) => {
    expect(turn(text).qualification_context.quantity).toBeUndefined();
  });

  test('narrative scope never becomes count evidence', () => {
    const out = turn('Hola', { diagnostic_datos: { scope: '1000 pastelones' }, requirement: '1000 pastelones' });
    expect(out.qualification_context.quantity).toBeUndefined();
  });

  test('domicilio maps explicit fulfillment without losing count', () => {
    const out = turn('Domicilio', {}, { pending_question_key: 'modality', qualification_context: { product: 'Pastelones', quantity: '649 unidades', modality: 'material' } });
    expect(out.qualification_context.modality).toBe('delivery');
    expect(out.pending_question_key).toBe('address');
    expect(out.qualification_context.quantity).toBe('649 unidades');
  });

  test('requested count wins over separate removal count', () => {
    const out = turn('Necesito 1000 pastelones y retirar 20 baldosas');
    expect(out.qualification_context.quantity).toBe('1000 unidades');
  });

  test('bare negated count is rejected before accepting replacement count', () => {
    const out = turn('No 1000 pastelones, necesito 200 unidades');
    expect(out.qualification_context.quantity).toBe('200 unidades');
  });

  test('literal commercial commune update works without legacy top-level city', () => {
    const out = turn('Necesito 1000 pastelones en Las Condes', { field_updates: { commune: 'Las Condes' } });
    expect(out.city).toBe('Las Condes');
    expect(out.qualification_context.commune).toBe('Las Condes');
  });

  test('fresh count replaces old area without requiring correction flags', () => {
    const out = turn('Necesito 1000 unidades', {}, { pending_question_key: 'product', qualification_context: { product: 'Pastelones', modality: 'delivery', measurements: '56m2' } });
    expect(out.qualification_context.quantity).toBe('1000 unidades');
    expect(out.qualification_context.measurements).toBeUndefined();
    expect(out.executive_summary).toContain('Cantidad/medidas: 1000 unidades');
    const both = turn('Necesito 1000 unidades para 56m2', {}, { pending_question_key: 'product', qualification_context: { product: 'Pastelones', modality: 'delivery', measurements: '20m2' } });
    expect(both.qualification_context.quantity).toBe('1000 unidades');
    expect(both.qualification_context.measurements).toBe('56m2');
  });

  test.each(['Solo retiro, no despacho', 'No necesito despacho', 'No a domicilio'])('negated delivery does not activate delivery: %s', (text) => {
    const out = turn(text, text.startsWith('Solo') ? { modality: 'pickup' } : {}, { pending_question_key: 'modality', qualification_context: { product: 'Pastelones', quantity: '649 unidades', modality: 'material' } });
    expect(out.qualification_context.modality).toBe(text.startsWith('Solo') ? 'pickup' : 'material');
  });

  test('accepted count advances through address and access, never premature handoff', () => {
    const quantity = turn('Necesito 1000 pastelones en Las Condes', transcript[0].model);
    expect(quantity.pending_question_key).toBe('address');
    const address = turn('Avenida Test 500', { field_updates: { address: 'Avenida Test 500' } }, {
      ...quantity, pending_question_key: 'address', qualification_context: quantity.qualification_context,
    });
    expect(address.pending_question_key).toBe('access_restrictions');
    expect(address.should_create_lead).toBe(false);
    const access = turn('Sin restricción de acceso', { field_updates: { access_restrictions: 'Sin restricción de acceso' } }, {
      ...address, pending_question_key: 'access_restrictions', qualification_context: address.qualification_context,
    });
    expect(access.pending_question_key).toBe('final_confirmation');
    expect(access.should_create_lead).toBe(false);
  });

  test('replayed four-turn request preserves corrections and exits bounded unanswered address loop', () => {
    let state = base;
    for (const [index, { message, model }] of transcript.entries()) {
      state = turn(message, model, state);
      expect(state.qualification_context.quantity).toBe('1000 unidades');
      expect(state.city).toBe('Las Condes');
      expect(state.qualification_context.commune).toBe('Las Condes');
      expect(state.service).toBe('Pastelones');
      expect(state.pending_question_key).toBe(index === 3 ? null : 'address');
      expect(state.should_create_lead).toBe(false);
      expect(state.should_escalate).toBe(index === 3);
    }
  });

  test('a false derivation promise still names a concrete next data question', () => {
    const out = turn('Quiero cotizar', { reply_text: 'He derivado tu caso' }, { service: null, city: null, requirement: null, qualification_context: {}, current_step: 'city', pending_question_key: null });
    expect(out.response_kind).toBe('prd_validated_fallback');
    expect(out.response_text).toContain('¿Desde qué ciudad nos escribes?');
  });

  test('human ownership and pending temporal choice cannot accept count evidence', () => {
    const owned = turn('Necesito 1000 pastelones', {}, { bot_suppressed: true });
    expect(owned.should_create_lead).toBe(false);
    expect(owned.should_escalate).toBe(false);
    expect(owned.response_text).toBe('');
    expect(owned.qualification_context.quantity).toBeUndefined();
    const choice = turn('Necesito 1000 pastelones', {}, { current_step: 'previous_context', pending_question_key: 'previous_context_choice', deterministic_reply: '¿Continuar o nueva?' });
    expect(choice.qualification_context.quantity).toBeUndefined();
    expect(choice.pending_question_key).toBe('previous_context_choice');
  });
});
