// =============================================================================
// A closed case starts over (owner, 2026-11-26): when a case is closed (the
// CRM's handoff.resolved, the ClickUp handoff closure or an ops reset), the
// next customer message starts a new conversation from zero. A closed
// conversation keeps its last `current_step` (`escalation|...`), and that step
// alone made the evaluator treat it as "escalation already required" and reuse
// it, so the new request landed on the resolved handoff and reached no one
// (production conversation 664, handoff 571). An open escalation still reuses
// its conversation.
// =============================================================================
import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const { evaluateConversationStep } = require('../fixtures/workflow-nodes/wa-conversation-orchestrator/evaluate-conversation-step.js');

const escalatedConversation = {
  phone_number: 'synthetic-contact', conversation_id: 664, target_conversation_id: 664,
  lead_id: 488, previous_lead_id: 488, has_existing_conversation: true, is_recent_conversation: true,
  has_active_conversation: false, is_stale_context: false, conversation_status_code: 'closed',
  current_step: 'escalation', state_service: null, state_city: null, state_requirement: null,
  last_known_service: null, last_known_city: null, last_known_requirement: null,
  qualification_context: {}, recent_messages: [
    { role: 'user', content: 'Hola, quiero hablar con una persona del equipo' },
    { role: 'assistant', content: 'Por supuesto 👍 Te derivaré con una persona del equipo para que continúe contigo.' },
  ],
  pending_question_key: null, human_arbitration_required: false, bot_suppressed: false,
  lead_clickup_task_id: null, lead_clickup_status: null,
  text_body: 'Hola, necesito hablar con una persona, por favor',
};
const evaluate = (extra = {}) => evaluateConversationStep({ ...escalatedConversation, ...extra }, {}).json;

describe('a closed case starts a new conversation', () => {
  test('a new request for a person opens a new conversation that escalates (a new handoff)', () => {
    const out = evaluate();
    expect(out.reset_conversation_lead).toBe(true);
    expect(out.conversation_id).toBeNull();
    expect(out.lead_id).toBeNull();
    expect(out.should_escalate).toBe(true);
    expect(out.escalation_reason).toBe('human_requested');
    expect(out.conversation_status_code).toBe('escalation_required');
  });

  test.each([
    ['a greeting', { text_body: 'Hola' }],
    ['a product question', { text_body: 'Necesito 20 bloques para Maipú' }],
    ['a neutral follow-up', { text_body: '¿Y entonces?' }],
    ['a thank-you', { text_body: 'Gracias' }],
  ])('a closed conversation left in the escalation step starts over on %s', (_label, extra) => {
    const out = evaluate(extra);
    expect(out.reset_conversation_lead).toBe(true);
    expect(out.conversation_id).toBeNull();
    expect(out.conversation_status_code).not.toBe('escalation_required');
  });

  test('an open escalation still reuses its conversation', () => {
    const out = evaluate({ conversation_status_code: 'escalation_required', has_active_conversation: true });
    expect(out.reset_conversation_lead).toBe(false);
    expect(out.conversation_id).toBe(664);
    expect(out.conversation_status_code).toBe('escalation_required');
  });
});
