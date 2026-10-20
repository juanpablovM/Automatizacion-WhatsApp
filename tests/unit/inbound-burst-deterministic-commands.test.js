// =============================================================================
// Inbound debounce: a burst of customer messages becomes ONE turn whose text is
// the messages joined with "\n" in arrival order. The deterministic commands
// that only match a whole message (a bare "asesor", "sí", "no", "gracias",
// "hay novedades") must keep working when they arrive as one line of a burst.
// Commands that trigger an action (human, new request) count when any line
// says them; answers that close a question (confirmation, rejection, courtesy,
// greeting) count only when every line says them, so "sí\npero cambia la
// cantidad a 60" never confirms a quote the customer is still correcting.
// =============================================================================
import { describe, expect, test } from 'vitest';
import { evaluateConversationStep } from '../fixtures/workflow-nodes/wa-conversation-orchestrator/evaluate-conversation-step.js';

const base = {
  phone_number: '56911111111',
  input_source_number_id: 7,
  message_type: 'text',
  inbound_event_id: 1,
  processing_token: 'claim-1',
  recent_messages: [],
};

const confirmStep = {
  ...base,
  conversation_id: 1,
  target_conversation_id: 1,
  has_existing_conversation: true,
  is_recent_conversation: true,
  has_active_conversation: true,
  conversation_status_code: 'waiting_user',
  current_step: 'confirm',
  state_service: 'Baldosas',
  state_city: 'Santiago',
  state_requirement: 'Patio 20 m2',
  pending_question_key: 'final_confirmation',
};

const handedToSales = {
  ...base,
  conversation_id: 1,
  target_conversation_id: 1,
  lead_id: 5,
  previous_lead_id: 5,
  has_existing_conversation: true,
  is_recent_conversation: true,
  has_active_conversation: true,
  conversation_status_code: 'handed_to_sales',
  current_step: 'complete',
};

const decide = (row, text) => {
  const output = evaluateConversationStep({ ...row, text_body: text }).json;
  return {
    response_kind: output.response_kind,
    escalation_reason: output.escalation_reason || null,
    v3_control_only: output.v3_control_only,
  };
};

describe('inbound burst — commands that act count on any line', () => {
  test('a human request on its own line escalates like the bare request', () => {
    expect(decide(base, 'Hola\nasesor')).toEqual(decide(base, 'asesor'));
    expect(decide(base, 'Hola\nasesor').escalation_reason).toBe('human_requested');
  });

  test('an opt-out inside a burst still closes the conversation', () => {
    expect(decide(base, 'Hola\nNo me escriban más')).toEqual(decide(base, 'No me escriban más'));
    expect(decide(base, 'Hola\nNo me escriban más').escalation_reason).toBe('opt_out');
  });

  test('a commercial correction inside a burst keeps the review flow', () => {
    expect(decide(handedToSales, 'Hola\nmodificar solicitud'))
      .toEqual(decide(handedToSales, 'modificar solicitud'));
  });

  test('a status inquiry inside a burst is answered as an inquiry', () => {
    expect(decide(handedToSales, 'Hola\nhay novedades'))
      .toEqual(decide(handedToSales, 'hay novedades'));
  });

  test('a new-request directive inside a burst starts a new request', () => {
    expect(decide(handedToSales, 'Hola\nnueva cotización').response_kind).toBe('new_request_started');
  });
});

describe('inbound burst — answers that close a question need every line', () => {
  test('a burst of confirmations confirms', () => {
    expect(decide(confirmStep, 'Sí\nOk')).toEqual(decide(confirmStep, 'Sí'));
    expect(decide(confirmStep, 'Sí\nOk').response_kind).toBe('handoff_ready');
  });

  test('a confirmation followed by a correction never confirms', () => {
    expect(decide(confirmStep, 'Sí\npero cambia la cantidad a 60').response_kind).not.toBe('handoff_ready');
  });

  test('a burst of rejections rejects', () => {
    expect(decide(confirmStep, 'No\nquiero cambiar')).toEqual(decide(confirmStep, 'No'));
  });

  test('a greeting plus thanks after the handoff stays in commercial review', () => {
    expect(decide(handedToSales, 'Hola\ngracias')).toEqual(decide(handedToSales, 'gracias'));
  });

  test('a burst of greetings is greeting-only', () => {
    expect(decide(handedToSales, 'Hola\nBuenas tardes')).toEqual(decide(handedToSales, 'Hola'));
  });
});

describe('inbound burst — single messages are unchanged', () => {
  test.each([
    [base, 'Hola'],
    [base, 'asesor'],
    [confirmStep, 'Sí'],
    [confirmStep, 'No'],
    [handedToSales, 'gracias'],
  ])('%#: a one-line message decides exactly as before', (row, text) => {
    expect(decide(row, `${text}\n`)).toEqual(decide(row, text));
  });
});
