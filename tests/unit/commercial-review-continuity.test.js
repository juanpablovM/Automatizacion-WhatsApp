import fs from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';
const require = createRequire(import.meta.url);
const { evaluateConversationStep } = require('../fixtures/workflow-nodes/wa-conversation-orchestrator/evaluate-conversation-step.js');
const root = 'tests/fixtures/workflow-nodes/';
const run = (path, row, env = {}) => new Function('items', '$env', fs.readFileSync(root + path, 'utf8'))([{ json: row }], env)[0].json;
const apply = (row, model = {}) => {
  const normalized = run('ai-lead-qualification-assistant/normalize-ai-result.js', {
    ai_context: { message_current: row.text_body, current_step: row.current_step, pending_question_key: row.pending_question_key, existing_fields: { service: row.service, city: row.city, requirement: row.requirement } },
    ai_status_code: 200, ai_response: { choices: [{ message: { content: JSON.stringify({ intent: 'quote_request', confidence: .95, ...model }) } }] },
  });
  return run('wa-conversation-orchestrator/apply-ai-assistance.js', { ...row, ...normalized,
    ...Object.fromEntries(Object.entries(row).map(([key, value]) => [key + '_1', value])) });
};
const quote = {
  phone_number: 'synthetic-contact', conversation_id: 100, target_conversation_id: 100,
  lead_id: 200, previous_lead_id: 200, has_existing_conversation: true, is_recent_conversation: true,
  has_active_conversation: false, is_stale_context: false, conversation_status_code: 'handed_to_sales',
  current_step: 'complete', state_service: 'Pastelones', state_city: 'Vitacura',
  state_requirement: '100 pastelones con despacho', last_known_service: 'Pastelones',
  last_known_city: 'Vitacura', last_known_requirement: '100 pastelones con despacho',
  qualification_context: { product: 'Pastelones', quantity: '100 unidades', commune: 'Vitacura', modality: 'delivery' },
  pending_question_key: null, text_body: 'Hola', human_arbitration_required: false, bot_suppressed: false,
};

describe('commercial review continuity', () => {
  test.each(['Hola', 'Gracias', '¿Cómo va mi cotización?', '¿Hay novedades?'])('preserves registered quote for a recent neutral message: %s', (text) => {
    const evaluated = evaluateConversationStep({ ...quote, text_body: text }).json;
    const out = run('wa-conversation-orchestrator/apply-ai-assistance.js', evaluated);
    expect(out.conversation_id).toBe(100);
    expect(out.lead_id).toBe(200);
    expect(out.qualification_context).toEqual(quote.qualification_context);
    expect(out.reset_conversation_lead).toBe(false);
    expect(out.should_create_lead).toBe(false);
    expect(out.should_escalate).toBe(false);
    expect(out.response_text).toContain('pendiente de revisión');
    const request = run('ai-lead-qualification-assistant/build-ai-request.js', evaluated);
    expect(request.ai_skipped).toBe(true);
    const opportunity = run('wa-inbound-downstream-dispatcher/ensure-early-opportunity.js', out);
    expect(opportunity.opportunity_write).toBe(false);
    const { resolveCancellationAction } = require('../fixtures/workflow-nodes/wa-inbound-downstream-dispatcher/ensure-follow-up-cancellation.js');
    expect(resolveCancellationAction(out).follow_up_should_schedule).toBe(false);
    expect(resolveCancellationAction(out).follow_up_cancel_action).toBe('none');
  });
  test('a previous phone lead does not prove an unlinked current conversation was quoted', () => {
    const out = evaluateConversationStep({ ...quote, lead_id: null }).json;
    expect(out.response_kind).not.toBe('commercial_review_pending');
    expect(out.reset_conversation_lead).toBe(true);
  });
  test('retains silent registered quote while human ownership is active', () => {
    const out = evaluateConversationStep({ ...quote, bot_suppressed: true }).json;
    expect(out.conversation_id).toBe(100);
    expect(out.qualification_context).toEqual(quote.qualification_context);
    expect(out.reset_conversation_lead).toBe(false);
    expect(out.deterministic_reply).toBe('');
    expect(out.response_kind).toBe('human_control_suppressed');
  });
  test('expired human lease does not create an infinite pending-review acknowledgment', () => {
    const out = evaluateConversationStep({ ...quote, human_arbitration_required: true }).json;
    expect(out.response_kind).not.toBe('commercial_review_pending');
    expect(out.human_arbitration_required).toBe(true);
  });
  test('explicit new request is allowed and clears the old quote', () => {
    const out = evaluateConversationStep({ ...quote, text_body: 'Nueva cotización' }).json;
    expect(out.reset_conversation_lead).toBe(true);
    expect(out.conversation_id).toBeNull();
    expect(out.qualification_context).toEqual({});
  });
  test('stale context over thirty days and absent archived conversation do not revive the quote', () => {
    for (const extra of [{ is_recent_conversation: false, is_stale_context: true, is_reengagement: false, elapsed_hours_since_last_inbound: 800 },
      { conversation_id: null, target_conversation_id: null, lead_id: null, previous_lead_id: null, has_existing_conversation: false, is_recent_conversation: false }]) {
      const out = evaluateConversationStep({ ...quote, ...extra }).json;
      expect(out.response_kind).not.toBe('commercial_review_pending');
      expect(out.reset_conversation_lead).toBe(true);
    }
  });
  test('opt-out wins over registered commercial review', () => {
    const out = evaluateConversationStep({ ...quote, text_body: 'No me escribas más' }).json;
    expect(out.conversation_status_code).toBe('closed');
    expect(out.escalation_reason).toBe('opt_out');
  });
});

describe('pickup quantity and contextual address question', () => {
  const base = { current_step: 'confirm', conversation_status_code: 'waiting_user',
    service: 'Pastelones', city: 'Vitacura', requirement: 'Pastelones para retirar en planta',
    qualification_context: { product: 'Pastelones', commune: 'Vitacura', modality: 'pickup' },
    pending_question_key: 'final_confirmation', should_create_lead: false, should_escalate: false, has_intent: true, text_body: 'Si' };
  test('pickup cannot create a lead without quantity even when the model approves', () => {
    const out = apply(base, { intent: 'confirmation_yes', confirmation_status: 'confirmed', should_create_lead: true });
    expect(out.should_create_lead).toBe(false);
    expect(out.pending_question_key).toBe('quantity');
    expect(out.commercial_missing_fields).toContain('quantity');
  });
  test('pickup captures quantity then asks final confirmation before creating the lead', () => {
    const out = apply({ ...base, pending_question_key: 'quantity', text_body: '100 pastelones' });
    expect(out.pending_question_key).toBe('final_confirmation');
    expect(out.qualification_context.quantity).toBe('100 unidades');
    expect(out.should_create_lead).toBe(false);
    const confirmed = apply({ ...base, qualification_context: out.qualification_context }, { intent: 'confirmation_yes', confirmation_status: 'confirmed', should_create_lead: true });
    expect(confirmed.should_create_lead).toBe(true);
  });
  test('address request distinguishes a known commune from street and approximate number', () => {
    const out = apply({ ...base, pending_question_key: 'address', text_body: 'Vitacura', qualification_context: { ...base.qualification_context, modality: 'delivery', quantity: '100 unidades' } });
    expect(out.pending_question_key).toBe('address');
    expect(out.response_text).toContain('Ya tengo Vitacura');
    expect(out.response_text).toContain('calle y número');
    expect(out.qualification_context.address).toBeUndefined();
  });
  test('repeated known commune advances the persisted address retry and bounded handoff', () => {
    const state = { ...quote, conversation_status_code: 'waiting_user', has_active_conversation: true,
      current_step: 'confirm', pending_question_key: 'address', text_body: 'Vitacura',
      previous_commercial_pending_question_key: 'address', previous_commercial_question_retry: 1 };
    const clarified = run('wa-conversation-orchestrator/apply-ai-assistance.js', evaluateConversationStep(state).json);
    expect(JSON.parse(clarified.metadata_json).commercial_question_retry).toBe(2);
    expect(clarified.response_text).toContain('calle y número');
    const escalated = run('wa-conversation-orchestrator/apply-ai-assistance.js', evaluateConversationStep({ ...state, previous_commercial_question_retry: 2 }).json);
    expect(escalated.should_escalate).toBe(true);
    expect(escalated.should_create_lead).toBe(false);
  });
  test('reaccepting the same AI commune is not new evidence for an unanswered address', () => {
    const state = { ...quote, conversation_status_code: 'waiting_user', has_active_conversation: true,
      current_step: 'confirm', pending_question_key: 'address', text_body: 'Vitacura',
      previous_commercial_pending_question_key: 'address', previous_commercial_question_retry: 1 };
    const out = apply(evaluateConversationStep(state).json, { city: 'Vitacura', field_updates: { commune: 'Vitacura' } });
    expect(JSON.parse(out.metadata_json).commercial_question_retry).toBe(2);
    expect(out.response_text).toContain('calle y número');
  });

  test('explicit fresh request clears prior commercial retry metadata', () => {
    const out = evaluateConversationStep({ ...quote, text_body: 'Nueva cotización',
      previous_commercial_pending_question_key: 'address', previous_commercial_question_retry: 2 }).json;
    const metadata = JSON.parse(out.metadata_json);
    expect(metadata.previous_commercial_pending_question_key).toBeNull();
    expect(metadata.previous_commercial_question_retry).toBe(0);
  });

  test('Evaluate transports only persisted question retry facts into Apply metadata', () => {
    const evaluated = evaluateConversationStep({ ...quote, conversation_status_code: 'waiting_user', has_active_conversation: true,
      current_step: 'confirm', pending_question_key: 'address', text_body: 'Vitacura', previous_commercial_pending_question_key: 'address', previous_commercial_question_retry: 1 }).json;
    const metadata = JSON.parse(evaluated.metadata_json);
    expect(metadata.previous_commercial_pending_question_key).toBe('address');
    expect(metadata.previous_commercial_question_retry).toBe(1);
  });
});
