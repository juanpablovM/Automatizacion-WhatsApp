import fs from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const {
  evaluateConversationStep,
  TERMINAL_REPLY_COOLDOWN_HOURS,
  ESCALATION_ALREADY_REQUIRED_REPLY,
  COMMERCIAL_REVIEW_PENDING_REPLY,
} = require('../fixtures/workflow-nodes/wa-conversation-orchestrator/evaluate-conversation-step.js');

const root = 'tests/fixtures/workflow-nodes/';
const run = (path, row, env = {}) => new Function('items', '$env', fs.readFileSync(root + path, 'utf8'))([{ json: row }], env)[0].json;

// `Should Send Response` in wa-inbound-downstream-dispatcher.json dispatches on
// Boolean(String($json.response_text || '').trim()). Silence is only real when
// that expression is false at the end of the orchestrator, so every case here
// is asserted on the prepared output and not just on the first node.
const turn = (row) => {
  const evaluated = evaluateConversationStep(row).json;
  const applied = run('wa-conversation-orchestrator/apply-ai-assistance.js', {
    ...evaluated,
    ...Object.fromEntries(Object.entries(evaluated).map(([key, value]) => [key + '_1', value])),
  });
  const prepared = run('wa-conversation-orchestrator/prepare-conversation-output.js', {
    ...applied,
    conversation_id_1: applied.conversation_id,
    current_step_1: applied.current_step,
  });
  return {
    evaluated,
    applied,
    prepared,
    metadata: JSON.parse(evaluated.metadata_json),
    dispatched: Boolean(String(prepared.response_text || '').trim()),
  };
};

const INSIDE_COOLDOWN_HOURS = 0.84; // the counterpart bot re-engages every ~50 minutes
const AFTER_COOLDOWN_HOURS = TERMINAL_REPLY_COOLDOWN_HOURS + 1;

const escalated = {
  phone_number: 'synthetic-escalated',
  source_number_id: 1,
  conversation_id: 900,
  target_conversation_id: 900,
  has_existing_conversation: true,
  is_recent_conversation: true,
  has_active_conversation: true,
  is_stale_context: false,
  conversation_status_code: 'escalation_required',
  current_step: 'escalation',
  state_current_step: 'escalation',
  escalation_reason: 'loop_detected',
  message_type: 'text',
  text_body: 'Hola, seguimos disponibles para lo que necesites',
  qualification_context: {},
  bot_suppressed: false,
  human_arbitration_required: false,
};

const reviewPending = {
  phone_number: 'synthetic-review',
  source_number_id: 1,
  conversation_id: 100,
  target_conversation_id: 100,
  lead_id: 200,
  previous_lead_id: 200,
  has_existing_conversation: true,
  is_recent_conversation: true,
  has_active_conversation: false,
  is_stale_context: false,
  conversation_status_code: 'handed_to_sales',
  current_step: 'complete',
  state_service: 'Pastelones',
  state_city: 'Vitacura',
  state_requirement: '100 pastelones con despacho',
  qualification_context: { product: 'Pastelones', quantity: '100 unidades', commune: 'Vitacura', modality: 'delivery' },
  pending_question_key: null,
  message_type: 'text',
  text_body: 'Hola',
  bot_suppressed: false,
  human_arbitration_required: false,
};

describe('contentless inbound never earns a reply', () => {
  test.each([
    ['empty body', ''],
    ['whitespace only', '   \n  '],
    ['punctuation only', '...'],
    ['emoji only', '🙂'],
    ['null body', null],
  ])('%s stays silent on an escalated conversation', (_label, text) => {
    const result = turn({ ...escalated, text_body: text });

    expect(result.evaluated.response_kind).toBe('reply_suppressed');
    expect(result.evaluated.deterministic_reply).toBe('');
    expect(result.applied.response_text).toBe('');
    expect(result.prepared.response_text).toBeNull();
    expect(result.dispatched).toBe(false);
  });

  test('a contentless inbound on a plain qualification turn also stays silent', () => {
    const result = turn({
      phone_number: 'synthetic-plain',
      source_number_id: 1,
      conversation_id: 300,
      target_conversation_id: 300,
      has_existing_conversation: true,
      is_recent_conversation: true,
      has_active_conversation: true,
      conversation_status_code: 'waiting_user',
      current_step: 'city',
      state_current_step: 'city',
      message_type: 'text',
      text_body: '',
      qualification_context: {},
    });

    expect(result.evaluated.response_kind).toBe('reply_suppressed');
    expect(result.dispatched).toBe(false);
  });

  test('an image with no caption is content and still gets its question', () => {
    const result = turn({
      phone_number: 'synthetic-media',
      source_number_id: 1,
      conversation_id: 301,
      target_conversation_id: 301,
      has_existing_conversation: true,
      is_recent_conversation: true,
      has_active_conversation: true,
      conversation_status_code: 'waiting_user',
      current_step: 'city',
      state_current_step: 'city',
      message_type: 'image',
      attachment_type: 'image',
      mime_type: 'image/jpeg',
      text_body: null,
      qualification_context: {},
    });

    expect(result.evaluated.response_kind).not.toBe('reply_suppressed');
    expect(result.dispatched).toBe(true);
  });

  test('a document with no caption is content and still gets its question', () => {
    const result = turn({
      phone_number: 'synthetic-media-doc',
      source_number_id: 1,
      conversation_id: 302,
      target_conversation_id: 302,
      has_existing_conversation: true,
      is_recent_conversation: true,
      has_active_conversation: true,
      conversation_status_code: 'waiting_user',
      current_step: 'city',
      state_current_step: 'city',
      message_type: 'document',
      attachment_type: 'document',
      filename: 'plano.pdf',
      text_body: null,
      qualification_context: {},
    });

    expect(result.evaluated.response_kind).not.toBe('reply_suppressed');
    expect(result.dispatched).toBe(true);
  });

  test('a contentless inbound does not advance or reset conversation state', () => {
    const result = turn({ ...escalated, text_body: '' });

    expect(result.evaluated.reset_conversation_lead).toBe(false);
    expect(result.evaluated.conversation_id).toBe(900);
    expect(result.evaluated.conversation_status_code).toBe('escalation_required');
    expect(result.evaluated.current_step).toBe('escalation');
  });
});

describe('terminal canned reply is sent once, then held for the cooldown', () => {
  test('escalation_already_required answers the first message', () => {
    const result = turn(escalated);

    expect(result.evaluated.response_kind).toBe('escalation_already_required');
    expect(result.evaluated.deterministic_reply).toBe(ESCALATION_ALREADY_REQUIRED_REPLY);
    expect(result.prepared.response_text).toBe(ESCALATION_ALREADY_REQUIRED_REPLY);
    expect(result.dispatched).toBe(true);
  });

  test('escalation_already_required stays silent inside the cooldown', () => {
    const result = turn({
      ...escalated,
      last_outgoing_text: ESCALATION_ALREADY_REQUIRED_REPLY,
      elapsed_hours_since_last_outbound: INSIDE_COOLDOWN_HOURS,
    });

    expect(result.evaluated.response_kind).toBe('reply_suppressed');
    expect(result.applied.response_text).toBe('');
    expect(result.prepared.response_text).toBeNull();
    expect(result.dispatched).toBe(false);
    expect(result.evaluated.conversation_status_code).toBe('escalation_required');
    expect(result.evaluated.should_escalate).toBe(true);
  });

  test('escalation_already_required answers again after the cooldown', () => {
    const result = turn({
      ...escalated,
      last_outgoing_text: ESCALATION_ALREADY_REQUIRED_REPLY,
      elapsed_hours_since_last_outbound: AFTER_COOLDOWN_HOURS,
    });

    expect(result.evaluated.response_kind).toBe('escalation_already_required');
    expect(result.prepared.response_text).toBe(ESCALATION_ALREADY_REQUIRED_REPLY);
    expect(result.dispatched).toBe(true);
  });

  test('commercial_review_pending answers the first message', () => {
    const result = turn(reviewPending);

    expect(result.evaluated.response_kind).toBe('commercial_review_pending');
    expect(result.evaluated.deterministic_reply).toBe(COMMERCIAL_REVIEW_PENDING_REPLY);
    expect(result.prepared.response_text).toBe(COMMERCIAL_REVIEW_PENDING_REPLY);
    expect(result.dispatched).toBe(true);
  });

  test('commercial_review_pending stays silent inside the cooldown', () => {
    const result = turn({
      ...reviewPending,
      last_outgoing_text: COMMERCIAL_REVIEW_PENDING_REPLY,
      elapsed_hours_since_last_outbound: INSIDE_COOLDOWN_HOURS,
    });

    expect(result.evaluated.response_kind).toBe('reply_suppressed');
    expect(result.applied.response_text).toBe('');
    expect(result.prepared.response_text).toBeNull();
    expect(result.dispatched).toBe(false);
    expect(result.evaluated.conversation_status_code).toBe('handed_to_sales');
    expect(result.evaluated.lead_id).toBe(200);
    expect(result.evaluated.qualification_context).toEqual(reviewPending.qualification_context);
  });

  test('commercial_review_pending answers again after the cooldown', () => {
    const result = turn({
      ...reviewPending,
      last_outgoing_text: COMMERCIAL_REVIEW_PENDING_REPLY,
      elapsed_hours_since_last_outbound: AFTER_COOLDOWN_HOURS,
    });

    expect(result.evaluated.response_kind).toBe('commercial_review_pending');
    expect(result.prepared.response_text).toBe(COMMERCIAL_REVIEW_PENDING_REPLY);
    expect(result.dispatched).toBe(true);
  });

  test('a different last outgoing line does not consume the cooldown', () => {
    const result = turn({
      ...escalated,
      last_outgoing_text: 'Claro. Te derivaré con una persona del equipo para continuar la atención.',
      elapsed_hours_since_last_outbound: INSIDE_COOLDOWN_HOURS,
    });

    expect(result.evaluated.response_kind).toBe('escalation_already_required');
    expect(result.dispatched).toBe(true);
  });

  test('the cooldown is six hours, so a customer returning the next morning is answered', () => {
    expect(TERMINAL_REPLY_COOLDOWN_HOURS).toBe(6);

    const nextMorning = turn({
      ...escalated,
      last_outgoing_text: ESCALATION_ALREADY_REQUIRED_REPLY,
      elapsed_hours_since_last_outbound: 14,
    });

    expect(nextMorning.dispatched).toBe(true);
  });
});

describe('a customer asking for something new is never silenced', () => {
  test('wantsNew breaks out of the escalation cooldown', () => {
    const result = turn({
      ...escalated,
      text_body: 'Nueva cotización',
      last_outgoing_text: ESCALATION_ALREADY_REQUIRED_REPLY,
      elapsed_hours_since_last_outbound: INSIDE_COOLDOWN_HOURS,
    });

    expect(result.evaluated.response_kind).not.toBe('reply_suppressed');
    expect(result.evaluated.response_kind).not.toBe('escalation_already_required');
    expect(result.dispatched).toBe(true);
  });

  test('wantsNew breaks out of the commercial review cooldown', () => {
    const result = turn({
      ...reviewPending,
      text_body: 'Nueva cotización',
      last_outgoing_text: COMMERCIAL_REVIEW_PENDING_REPLY,
      elapsed_hours_since_last_outbound: INSIDE_COOLDOWN_HOURS,
    });

    expect(result.evaluated.response_kind).not.toBe('reply_suppressed');
    expect(result.evaluated.response_kind).not.toBe('commercial_review_pending');
    expect(result.evaluated.reset_conversation_lead).toBe(true);
    expect(result.dispatched).toBe(true);
  });
});

describe('suppression leaves an audit trail', () => {
  test('a contentless inbound records why it was silenced', () => {
    const { metadata } = turn({ ...escalated, text_body: '' });

    expect(metadata.reply_suppressed).toBe(true);
    expect(metadata.reply_suppression_reason).toBe('contentless_inbound');
    expect(metadata.suppressed_response_kind).toBeNull();
  });

  test('a cooldown suppression records the line it withheld', () => {
    const { metadata, evaluated } = turn({
      ...escalated,
      last_outgoing_text: ESCALATION_ALREADY_REQUIRED_REPLY,
      elapsed_hours_since_last_outbound: INSIDE_COOLDOWN_HOURS,
    });

    expect(evaluated.audit_event_name).toBe('conversation_state_evaluated');
    expect(metadata.reply_suppressed).toBe(true);
    expect(metadata.reply_suppression_reason).toBe('terminal_reply_cooldown');
    expect(metadata.suppressed_response_kind).toBe('escalation_already_required');
  });

  test('a commercial cooldown suppression records its own withheld kind', () => {
    const { metadata } = turn({
      ...reviewPending,
      last_outgoing_text: COMMERCIAL_REVIEW_PENDING_REPLY,
      elapsed_hours_since_last_outbound: INSIDE_COOLDOWN_HOURS,
    });

    expect(metadata.reply_suppressed).toBe(true);
    expect(metadata.reply_suppression_reason).toBe('terminal_reply_cooldown');
    expect(metadata.suppressed_response_kind).toBe('commercial_review_pending');
  });

  test('an ordinary answered turn is not marked as suppressed', () => {
    const { metadata } = turn(escalated);

    expect(metadata.reply_suppressed).toBe(false);
    expect(metadata.reply_suppression_reason).toBeNull();
  });
});

describe('human control keeps its own silence path', () => {
  test('an owned conversation is still human_control_suppressed, not reply_suppressed', () => {
    const result = turn({ ...escalated, bot_suppressed: true });

    expect(result.evaluated.response_kind).toBe('human_control_suppressed');
    expect(result.evaluated.deterministic_reply).toBe('');
    expect(result.evaluated.bot_suppressed).toBe(true);
    expect(result.dispatched).toBe(false);
  });

  test('human control still wins over a contentless inbound', () => {
    const result = turn({ ...escalated, bot_suppressed: true, text_body: '' });

    expect(result.evaluated.response_kind).toBe('human_control_suppressed');
    expect(result.dispatched).toBe(false);
  });
});
