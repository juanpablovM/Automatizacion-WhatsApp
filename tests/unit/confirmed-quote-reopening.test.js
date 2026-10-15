// =============================================================================
// Quote correction (owner decision 2026-10-14, conversations 496/497): a
// customer who writes after confirming a quote whose ClickUp task is still open
// continues that same quote. The turn keeps the conversation, its lead, its
// qualification_context and its history, and goes to the v3.1 model, which
// applies the change, re-summarizes and asks to confirm again. A closed task,
// no task, an explicit new-quote directive or a seller-owned chat keep today's
// behavior.
// =============================================================================
import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const { evaluateConversationStep } = require('../fixtures/workflow-nodes/wa-conversation-orchestrator/evaluate-conversation-step.js');

const history = [
  { role: 'user', content: 'Necesito 50 bloques para Maipú, con despacho' },
  { role: 'assistant', content: 'Te resumo: 50 bloques con despacho a Maipú. ¿Está correcto?' },
  { role: 'user', content: 'Sí' },
];
const confirmedQuote = {
  phone_number: 'synthetic-contact', conversation_id: 496, target_conversation_id: 496,
  lead_id: 402, previous_lead_id: 402, has_existing_conversation: true, is_recent_conversation: true,
  has_active_conversation: false, is_stale_context: false, conversation_status_code: 'handed_to_sales',
  current_step: 'complete', state_service: 'despacho', state_city: 'Maipú',
  state_requirement: '• 50 bloques', last_known_service: 'despacho', last_known_city: 'Maipú',
  last_known_requirement: '• 50 bloques',
  qualification_context: { line_items: [{ item_id: 'i1', product: 'Bloques', quantity: '50' }], commune: 'Maipú', fulfillment: 'delivery' },
  recent_messages: history,
  pending_question_key: null, human_arbitration_required: false, bot_suppressed: false,
  lead_clickup_task_id: '86e3qf426', lead_clickup_status: 'to do',
  text_body: 'Perdón, me equivoqué: son 80 bloques, no 50',
};
const evaluate = (extra = {}, env = {}) => evaluateConversationStep({ ...confirmedQuote, ...extra }, env).json;

describe('reopening a confirmed quote whose ClickUp task is open', () => {
  test.each([
    ['a correction', {}],
    ['a status never reported by ClickUp', { lead_clickup_status: null }],
    ['the legacy modification command', { text_body: 'Quiero modificar mi solicitud' }],
    ['an addition with detail', { text_body: 'Se me olvidó agregar 20 soleras' }],
    ['the detail after the legacy correction prompt', { text_body: 'Son 80', pending_question_key: 'commercial_review_correction' }],
  ])('continues the same quote for %s', (_label, extra) => {
    const out = evaluate(extra);
    expect(out.reopen_confirmed_quote).toBe(true);
    expect(out.conversation_id).toBe(496);
    expect(out.lead_id).toBe(402);
    expect(out.reset_conversation_lead).toBe(false);
    expect(out.qualification_context).toEqual(confirmedQuote.qualification_context);
    expect(out.recent_messages).toEqual(history);
    expect(out.v3_control_only).toBe(false);
    expect(out.should_create_lead).toBe(false);
    expect(out.should_escalate).toBe(false);
    expect(out.conversation_status_code).toBe('waiting_user');
    expect(out.pending_question_key).toBeNull();
    expect(out.deterministic_reply).toBe('');
  });

  test('a greeting or a status inquiry still gets the commercial review reply', () => {
    for (const text_body of ['Hola', 'Gracias', '¿Cómo va mi cotización?']) {
      const out = evaluate({ text_body });
      expect(out.reopen_confirmed_quote).toBe(false);
      expect(out.response_kind).toBe('commercial_review_pending');
      expect(out.v3_control_only).toBe(true);
    }
  });

  test.each([
    ['a closed task', { lead_clickup_status: 'Cerrada' }, { CLICKUP_STATUS_RESOLVED: 'cerrada' }],
    ['a task closed under the default resolved list', { lead_clickup_status: 'complete' }, {}],
    ['no ClickUp task', { lead_clickup_task_id: null }, {}],
    ['an explicit new quote', { text_body: 'Quiero una nueva cotización' }, {}],
  ])('starts a new request for %s', (_label, extra, env) => {
    const out = evaluate(extra, env);
    expect(out.reopen_confirmed_quote).toBe(false);
    expect(out.reset_conversation_lead).toBe(true);
    expect(out.conversation_id).toBeNull();
    expect(out.response_kind).toBe('new_request_started');
  });

  test('a closed task keeps the legacy correction prompt for a modification command', () => {
    const out = evaluate({ text_body: 'Quiero modificar mi solicitud', lead_clickup_status: 'complete' });
    expect(out.reopen_confirmed_quote).toBe(false);
    expect(out.pending_question_key).toBe('commercial_review_correction');
    expect(out.v3_control_only).toBe(true);
  });

  test('a seller-owned chat stays silent', () => {
    const out = evaluate({ bot_suppressed: true });
    expect(out.reopen_confirmed_quote).toBe(false);
    expect(out.response_kind).toBe('human_control_suppressed');
    expect(out.deterministic_reply).toBe('');
  });

  test('an expired human lease awaiting arbitration is not reopened', () => {
    expect(evaluate({ human_arbitration_required: true }).reopen_confirmed_quote).toBe(false);
  });

  test('a conversation older than the 48h window is not reopened', () => {
    expect(evaluate({ is_recent_conversation: false, is_stale_context: true, is_reengagement: true }).reopen_confirmed_quote).toBe(false);
  });
});
