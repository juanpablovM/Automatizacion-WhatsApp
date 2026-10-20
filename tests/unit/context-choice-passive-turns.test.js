import fs from 'node:fs';
import { describe, expect, test } from 'vitest';
import { evaluateConversationStep } from '../fixtures/workflow-nodes/wa-conversation-orchestrator/evaluate-conversation-step.js';

const root = 'tests/fixtures/workflow-nodes/';
const run = (path, row, env = {}) => new Function('items', '$env', fs.readFileSync(root + path, 'utf8'))([{ json: row }], env)[0].json;
// The follow-up policy node is composed with a shared runtime, so it runs from
// the synced workflow rather than from the bare fixture.
const followUpNode = JSON.parse(fs.readFileSync('n8n/workflows/wa-inbound-downstream-dispatcher.json', 'utf8'))
  .nodes.find((node) => node.name === 'Ensure Follow-Up Cancellation').parameters.jsCode;
const runFollowUpNode = (row, env = {}) => new Function('items', '$env', followUpNode)([{ json: row }], env)[0].json;
const context = { product: 'Cierro', commune: 'Chicureo', quantity: '20 unidades', modality: 'material' };
const base = {
  phone_number: 'test-passive-context', source_number_id: 1, conversation_id: 51, target_conversation_id: 51,
  has_existing_conversation: true, has_active_conversation: true, is_recent_conversation: true,
  conversation_status_code: 'waiting_user', current_step: 'previous_context', pending_question_key: 'previous_context_choice',
  qualification_context: context, message_type: 'text',
  state_current_step: 'previous_context|' + encodeURIComponent(JSON.stringify({ service: 'Cierro', city: 'Chicureo', requirement: 'Cotizar 20 unidades' })),
};
const process = (text, extra = {}) => {
  const evaluated = evaluateConversationStep({ ...base, ...extra, text_body: text }).json;
  const ai = run('ai-lead-qualification-assistant/build-ai-request.js', evaluated, { AI_DIRECT_API_KEY: 'test-key', AI_DIRECT_API_MODEL: 'test-model' });
  const applied = run('wa-conversation-orchestrator/apply-ai-assistance.js', {
    ...ai, ...Object.fromEntries(Object.entries(evaluated).map(([key, value]) => [key + '_1', value])),
  });
  const prepared = run('wa-conversation-orchestrator/prepare-conversation-output.js', {
    ...applied, conversation_id_1: 51, current_step_1: applied.current_step,
    response_text_1: 'Stale fallback must never reach the client',
  });
  return { evaluated, ai, applied, prepared };
};
const followup = (row, env = {}) => runFollowUpNode({ ...row, inbound_event_id: 101, message_id: 201, inbound_created_at: '2026-09-13T00:30:00Z' }, env);

const assertPending = ({ applied, prepared, ai }) => {
  expect(ai.ai_request).toBeNull();
  expect(applied.pending_question_key).toBe('previous_context_choice');
  expect(prepared.pending_question_key).toBe('previous_context_choice');
  expect(applied.qualification_context).toEqual(context);
  expect(applied.should_create_lead).toBe(false);
  expect(applied.should_escalate).toBe(false);
};

describe('pending context choice — postponement and passive messages', () => {
  test.each(['Háblame mañana', 'Mañana', 'Hablamos mañana', 'Gracias, mañana hablamos'])('acknowledges postponement instead of repeating consent: %s', (text) => {
    const result = process(text);
    assertPending(result);
    expect(result.prepared.response_text).toMatch(/mañana/i);
    expect(result.prepared.response_text).not.toMatch(/continuar.*anterior|iniciar.*nueva|llamar|vendedor/i);
    const policy = followup(result.prepared);
    expect(policy.follow_up_cancel_action).toBe('cancel');
    expect(policy.follow_up_cancel_reason).toBe('postponed_until_tomorrow');
    expect(policy.follow_up_should_schedule).toBe(true);
    expect(policy.follow_up_scheduled_at).toBeNull();
  });

  test.each(['Gracias', 'Gracias por todo', 'Hasta luego', 'Chao'])('courtesy does not ask consent again or cancel a requested reminder: %s', (text) => {
    const result = process(text);
    assertPending(result);
    expect(result.prepared.response_text).not.toMatch(/continuar.*anterior|iniciar.*nueva/);
    const policy = followup(result.prepared);
    expect(policy.follow_up_cancel_action).toBe('none');
    expect(policy.follow_up_should_schedule).toBe(false);
    expect(run('wa-inbound-downstream-dispatcher/ensure-early-opportunity.js', result.prepared).opportunity_write).toBe(false);
  });

  test.each([{ type: 'reaction', text: '😂' }, { type: 'sticker', text: null }, { type: 'text', text: '😂' }])('reaction or sticker remains silent through output preparation: $type', ({ type, text }) => {
    const result = process(text, { message_type: type });
    assertPending(result);
    expect(result.applied.response_text).toBe('');
    expect(result.prepared.response_text).toBeNull();
    expect(followup(result.prepared).follow_up_cancel_action).toBe('none');
    expect(followup(result.prepared).follow_up_should_schedule).toBe(false);
  });

  test('ambiguous yes still asks for an explicit choice', () => {
    const result = process('Si');
    assertPending(result);
    expect(result.prepared.response_text).toMatch(/anterior.*nueva/);
  });

  test.each(['Continuar', 'Una nueva'])('explicit choice still works after a postponement: %s', (text) => {
    const postponed = process('Háblame mañana').applied;
    const result = process(text, { current_step: postponed.current_step, state_current_step: postponed.current_step, qualification_context: postponed.qualification_context });
    expect(result.evaluated.pending_question_key).not.toBe('previous_context_choice');
    expect(result.evaluated.reset_conversation_lead).toBe(text === 'Una nueva');
    expect(result.evaluated.used_previous_context).toBe(text === 'Continuar');
  });

  test('human ownership suppresses replies, scheduling and cancellation', () => {
    const result = process('Háblame mañana', { bot_suppressed: true });
    expect(result.prepared.response_text).toBeNull();
    expect(result.prepared.should_create_lead).toBe(false);
    expect(result.prepared.should_escalate).not.toBe(true);
    expect(followup(result.prepared).follow_up_cancel_action).toBe('none');
    expect(followup(result.prepared).follow_up_should_schedule).toBe(false);
  });

  test('opt-out takes precedence over a postponement', () => {
    const result = process('Háblame mañana pero no me escribas más');
    expect(result.applied.conversation_status_code).toBe('closed');
    expect(followup(result.prepared).follow_up_cancel_action).toBe('opt_out');
    expect(followup(result.prepared).follow_up_should_schedule).toBe(false);
  });

  test('a commercial delivery date is not a chat postponement', () => {
    const result = process('Necesito despacho mañana');
    expect(result.prepared.response_text).toMatch(/anterior.*nueva/);
    expect(followup(result.prepared).follow_up_cancel_reason).not.toBe('postponed_until_tomorrow');
  });

  test('unsupported postponement does not silently become tomorrow', () => {
    const result = process('Pasado mañana');
    assertPending(result);
    expect(result.prepared.response_text).not.toMatch(/anterior.*nueva/);
    expect(followup(result.prepared).follow_up_should_schedule).toBe(false);
    expect(followup(result.prepared).follow_up_cancel_reason).not.toBe('postponed_until_tomorrow');
  });

  test('malformed configured send window cannot create a reminder', () => {
    const policy = followup(process('Mañana').prepared, { FOLLOW_UP_WINDOW_START: 'not-a-time', FOLLOW_UP_WINDOW_END: '18:00' });
    expect(policy.follow_up_should_schedule).toBe(false);
    expect(policy.follow_up_scheduled_at).toBeNull();
    expect(policy.follow_up_schedule_skipped_reason).toBe('invalid_send_window');
  });

  test('missing persisted event identity cannot promise a queued reminder', () => {
    const policy = runFollowUpNode(process('Mañana').prepared);
    expect(policy.follow_up_should_schedule).toBe(false);
    expect(policy.follow_up_scheduled_at).toBeNull();
  });

  test('passes existing send-window settings to the SQL date calculation', () => {
    const policy = followup(process('Mañana').prepared, { FOLLOW_UP_WINDOW_START: '10:00', FOLLOW_UP_WINDOW_END: '18:00' });
    expect(policy.follow_up_window_start).toBe('10:00');
    expect(policy.follow_up_window_end).toBe('18:00');
  });
});
