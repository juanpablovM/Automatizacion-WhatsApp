import fs from 'node:fs';
import { describe, expect, test } from 'vitest';
import { evaluateConversationStep } from '../fixtures/workflow-nodes/wa-conversation-orchestrator/evaluate-conversation-step.js';

const root = 'tests/fixtures/workflow-nodes/';
const code = (path, row, env = {}) => new Function('items', '$env', fs.readFileSync(root + path, 'utf8'))([{ json: row }], env)[0].json;
const apply = (deterministic, ai = {}) => code('wa-conversation-orchestrator/apply-ai-assistance.js', {
  ...deterministic, ...ai,
  ...Object.fromEntries(Object.entries(deterministic).map(([key, value]) => [key + '_1', value])),
});
const normalize = (text, fields = {}) => code('ai-lead-qualification-assistant/normalize-ai-result.js', {
  ai_context: { message_current: text }, ai_status_code: 200,
  ai_response: { choices: [{ message: { content: JSON.stringify({ intent: 'provide_info', confidence: 0.95, ...fields }) } }] },
});
const base = {
  phone_number: 'test-context-recovery', conversation_id: 159, target_conversation_id: 159,
  has_existing_conversation: true, has_active_conversation: true, is_recent_conversation: true,
  is_stale_context: false, is_reengagement: false, conversation_status_code: 'waiting_user',
  current_step: 'requirement', state_service: 'Adoquines', state_city: 'Chicureo',
  state_requirement: 'Instalación de adoquines', message_type: 'text',
  qualification_context: { product: 'Adoquines', commune: 'Chicureo', modality: 'installation', measurements: '56m2' },
};
const evaluate = (text, extra = {}) => evaluateConversationStep({ ...base, ...extra, text_body: text }).json;

describe('contact context recovery — historical transcript regressions', () => {
  test.each(['holaa', 'Hola, qué tal?', 'no tengo claro aún', 'gracias'])('does not classify arbitrary text as service: %s', (text) => {
    expect(evaluate(text, { has_active_conversation: false, has_existing_conversation: false, conversation_id: null }).service).toBeNull();
  });

  test('installation of adocreto resolves product before modality', () => {
    expect(evaluate('Instalación de adocreto', { state_service: null, state_requirement: null }).service).toBe('Adocreto');
  });

  test('captures Chicureo and quantities without false legacy city retries', () => {
    const out = evaluate('Chicureo instalación 20mt', { state_city: null, current_step: 'city_retry_2', state_requirement: null });
    expect(out.city).toBe('Chicureo');
    expect(out.should_escalate).toBe(false);
    expect(apply(out, normalize('Chicureo instalación 20mt')).qualification_context.measurements).toBe('20mt');
  });

  test('expired context waits for choice, without giving historical facts to the model', () => {
    const out = evaluate('Hola', { has_active_conversation: false, is_recent_conversation: false, is_stale_context: true, is_reengagement: true, elapsed_hours_since_last_inbound: 78 });
    const req = code('ai-lead-qualification-assistant/build-ai-request.js', out, { AI_DIRECT_API_KEY: 'test-key', AI_DIRECT_API_MODEL: 'test-model' });
    expect(req.ai_request).toBeNull();
    expect(req.ai_context.qualification_context).toEqual({});
    expect(req.ai_context.existing_fields).toEqual({ service: '', city: '', requirement: '' });
    expect(req.ai_context.recent_messages).toEqual([]);
    const applied = apply(out, { confidence: 1, field_updates: { product: 'Pastelones', quantity: '649' }, escalation_area: 'sales', should_create_lead: true, reply_text: 'Confirma tus pastelones' });
    expect(applied.current_step.split('|')[0]).toBe('previous_context');
    expect(applied.pending_question_key).toBe('previous_context_choice');
    expect(applied.should_create_lead).toBe(false);
    expect(applied.should_escalate).toBe(false);
    expect(applied.qualification_context).toEqual(base.qualification_context);
    expect(applied.ai_applied).toBe(false);
  });

  test.each(['Una nueva', 'Nueva cotización', 'continuar con una nueva', 'Quiero iniciar una nueva. Quiero cotizar cierro'])('new choice cleans old context and retries: %s', (text) => {
    const out = evaluate(text, { current_step: 'previous_context', state_current_step: 'previous_context', pending_question_key: 'previous_context_choice', has_active_conversation: false, is_recent_conversation: false, is_stale_context: true, is_reengagement: true });
    expect(out.reset_conversation_lead).toBe(true);
    expect(out.qualification_context).toEqual({});
    expect(out.pending_question_key).toBeNull();
    expect(out.current_step).not.toMatch(/retry|previous_context/);
    if (text.includes('cierro')) expect(out.service).toBe('Cierro');
  });

  test('explicit continuation restores previous state even without a lead', () => {
    const out = evaluate('Continuar con la anterior', { has_active_conversation: false, current_step: 'previous_context', pending_question_key: 'previous_context_choice', is_reengagement: true, last_known_service: 'Adoquines', last_known_city: 'Chicureo', last_known_requirement: 'Instalar 56m2' });
    expect(out.used_previous_context).toBe(true);
    expect(out.service).toBe('Adoquines');
    expect(out.city).toBe('Chicureo');
    expect(out.qualification_context).toEqual(base.qualification_context);
    expect(out.pending_question_key).not.toBe('previous_context_choice');
  });

  test.each(['Continuar', 'Continuar con la anterior'])('persisted temporal choice resumes complete request without a lead: %s', (text) => {
    const first = apply(evaluate('Hola', { has_active_conversation: false, is_reengagement: true }));
    const resumed = evaluate(text, { current_step: first.current_step, state_current_step: first.current_step,
      pending_question_key: first.pending_question_key, qualification_context: first.qualification_context,
      state_service: null, state_city: null, state_requirement: null, last_known_service: null, last_known_city: null, last_known_requirement: null });
    expect(resumed.used_previous_context).toBe(true);
    expect(resumed.service).toBe('Adoquines');
    expect(resumed.city).toBe('Chicureo');
    expect(resumed.requirement).toBe('Instalación de adoquines');
    expect(resumed.qualification_context.measurements).toBe('56m2');
    expect(resumed.qualification_context.modality).toBe('installation');
  });

  test('new choice followed by Santiago 30mtl cierro does not inherit 56m2 or installation', () => {
    const first = apply(evaluate('Hola', { has_active_conversation: false, is_reengagement: true }));
    const next = evaluate('Una nueva', { current_step: first.current_step, state_current_step: first.current_step, pending_question_key: first.pending_question_key, qualification_context: first.qualification_context });
    const fresh = evaluate('Santiago, 30 mtl de cierro', { conversation_id: 200, current_step: next.current_step, pending_question_key: next.pending_question_key,
      state_service: next.service, state_city: next.city, state_requirement: next.requirement, qualification_context: next.qualification_context });
    const applied = apply(fresh, normalize(fresh.text_body));
    expect(applied.service).toBe('Cierro');
    expect(applied.city).toBe('Santiago');
    expect(applied.qualification_context.product).toBe('Cierro');
    expect(applied.qualification_context.measurements).toBe('30 mtl');
    expect(applied.qualification_context.modality).toBeUndefined();
    expect(applied.should_create_lead).toBe(false);
  });

  test.each(['Felipe', 'como estas', 'perfecto', 'no porque me llamo felipe', 'todavía no tengo los datos'])('unprompted arbitrary text is not a commercial service: %s', (text) => {
    const out = evaluate(text, { state_service: null, state_requirement: null });
    expect(out.service).toBeNull();
  });

  test('adocreto is not OC, but explicit OC still routes B2B', () => {
    expect(evaluate('Instalación de adocreto').response_kind).not.toBe('b2b_redirect');
    expect(evaluate('Compra con OC').response_kind).toBe('b2b_redirect');
  });

  test('numeric quantity is preserved from model fields with direct user evidence', () => {
    const text = 'Necesito 1000 unidades de pastelones';
    const applied = apply(evaluate(text), normalize(text, { field_updates: { quantity: 1000 } }));
    expect(applied.qualification_context.quantity).toBe(1000);
  });

  test('opt-out outranks measurement help and re-engagement', () => {
    const out = apply(evaluate('Pueden venir a medir pero no me escribas más', { is_reengagement: true, pending_question_key: 'quantity' }), normalize('no me escribas más'));
    expect(out.escalation_reason).toBe('opt_out');
    expect(out.conversation_status_code).toBe('closed');
    expect(out.response_text).toBe('Entendido. No te escribiremos más.');
  });

  test('more than 30 days ignores inherited context', () => {
    const out = evaluate('Instalar cierro en Santiago 30mtl', { has_active_conversation: false, is_recent_conversation: false, is_stale_context: true, elapsed_hours_since_last_inbound: 31 * 24 });
    const applied = apply(out, normalize(out.text_body));
    expect(out.reset_conversation_lead).toBe(true);
    expect(applied.qualification_context.product).toBe('Cierro');
    expect(applied.qualification_context.measurements).toBe('30mtl');
    expect(applied.qualification_context.modality).toBe('installation');
  });

  test('existing pastelones to remove do not replace requested adoquines, even when AI proposes replacement', () => {
    const text = 'si requiere, tiene pastelones actualmente';
    const out = evaluate(text, { current_step: 'confirm', pending_question_key: 'debris_removal' });
    const applied = apply(out, normalize(text, { service: 'Pastelones Actualmente', field_updates: { product: 'Pastelones Actualmente' } }));
    expect(applied.qualification_context.product).toBe('Adoquines');
    expect(applied.qualification_context.debris_removal).toBe(true);
    expect(applied.service).toBe('Adoquines');
    expect(applied.should_escalate).toBe(false);
  });

  test('requested and existing products in one message retain requested product', () => {
    const text = 'Quiero instalar adoquines, tengo pastelones actualmente';
    const applied = apply(evaluate(text, { qualification_context: {}, state_service: null }), normalize(text));
    expect(applied.qualification_context.product).toBe('Adoquines');
  });

  test('catalog grounding cannot select a negated product', () => {
    const text = 'Son pastelones no baldosas';
    const model = normalize(text, { intent: 'correction', catalog_matches: [{ name: 'Baldosas' }, { name: 'Pastelones' }] });
    const applied = apply(evaluate(text, { qualification_context: { product: 'Baldosas' }, state_service: 'Baldosas' }), { ...model, catalog_matches: [{ name: 'Baldosas' }, { name: 'Pastelones' }] });
    expect(applied.qualification_context.product).toBe('Pastelones');
  });

  test('a product to remove is not the product to purchase', () => {
    const text = 'Quiero instalar adoquines y retirar pastelones';
    const applied = apply(evaluate(text, { qualification_context: {}, state_service: null }), normalize(text));
    expect(applied.qualification_context.product).toBe('Adoquines');
  });

  test('product correction records concept, not negated product suffix', () => {
    const text = 'Son pastelones no baldosas';
    const applied = apply(evaluate(text, { qualification_context: { product: 'Baldosas' }, state_service: 'Baldosas' }), normalize(text, { intent: 'correction' }));
    expect(applied.qualification_context.product).toBe('Pastelones');
    expect(applied.service).toBe('Pastelones');
  });

  test.each(['no tengo claro aún', 'Pueden venir a medir uds', 'No sé muy bien aún'])('unknown measure routes to existing human review instead of insisting: %s', (text) => {
    const applied = apply(evaluate(text, { current_step: 'confirm', pending_question_key: 'quantity', qualification_context: { product: 'Adoquines', modality: 'installation' } }), normalize(text));
    expect(applied.should_escalate).toBe(true);
    expect(applied.should_create_lead).toBe(false);
    expect(applied.response_text).toMatch(/persona del equipo/);
    expect(applied.response_text).not.toMatch(/cantidad aproximada|confirmas/);
  });

  test('human ownership still suppresses all automated effects', () => {
    const applied = apply(evaluate('Pueden venir a medir uds', { bot_suppressed: true, current_step: 'confirm', pending_question_key: 'quantity' }), normalize('Pueden venir a medir uds'));
    expect(applied.response_text).toBe('');
    expect(applied.should_escalate).toBe(false);
    expect(applied.should_create_lead).toBe(false);
  });
});
