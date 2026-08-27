// =============================================================================
// Fixture Contract Test — Conversation Flow
// -----------------------------------------------------------------------------
// Memoria #679, #686: fixture-level contract for deterministic conversation logic.
// This is not an end-to-end test; runtime boundaries are covered separately.
// =============================================================================

import { describe, test, expect } from 'vitest';
import { evaluateConversationStep } from '../fixtures/workflow-nodes/wa-conversation-orchestrator/evaluate-conversation-step.js';

describe('Fixture contract — Conversation Flow (memoria #686)', () => {
  const baseInput = {
    phone_number: 'test-contact-001',
    source_number_id: 1,
    instance_name: 'test-instance',
    inbound_event_id: 1,
    processing_token: 'token-123',
    whatsapp_name: 'Test User',
    external_contact_id: 'test-contact-001',
    external_message_id: 'msg-1',
    external_timestamp: new Date().toISOString(),
    message_type: 'text',
    text_body: 'Hola',
    raw_payload_json: '{}',
    attachment_type: null,
    mime_type: null,
    filename: null,
    external_media_id: null,
    external_url: null,
    sha256: null,
    file_size: null,
    // SQL-provided fields (memoria #686):
    has_active_conversation: false,
    conversation_status_code: 'new',
    elapsed_hours_since_last_inbound: null,
    is_reengagement: false,
    has_pending_followups: false,
    last_known_service: null,
    last_known_city: null,
    last_known_requirement: null,
    previous_lead_id: null,
    previous_whatsapp_name: null,
    previous_service: null,
    previous_city: null,
    previous_requirement: null,
    state_service: null,
    state_city: null,
    state_requirement: null,
    state_current_step: null,
    current_step: 'city',
    qualification_context: {},
    pending_question_key: null,
    recent_messages: [],
  };

  test('first interaction -> welcome_and_question at city step', () => {
    const result = evaluateConversationStep({ ...baseInput, text_body: 'Hola' });
    expect(result.json.response_kind).toBe('welcome_and_question');
    expect(result.json.current_step).toContain('city');
    expect(result.json.conversation_id).toBeNull(); // firstInteraction = true
    expect(result.json.reset_conversation_lead).toBe(true);
  });

  test('city detection -> service step', () => {
    const withCity = {
      ...baseInput,
      has_active_conversation: true,
      conversation_id: 1,
      conversation_status_code: 'waiting_user',
      current_step: 'city',
      state_current_step: 'city',
      text_body: 'Santiago',
    };
    const result = evaluateConversationStep(withCity);
    expect(result.json.city).toBe('Santiago');
    expect(result.json.current_step).toContain('service');
  });

  test('service detection -> requirement step', () => {
    const withService = {
      ...baseInput,
      has_active_conversation: true,
      conversation_id: 1,
      conversation_status_code: 'waiting_user',
      current_step: 'service',
      state_current_step: 'service',
      city: 'Santiago',
      state_city: 'Santiago',
      text_body: 'Baldosas',
    };
    const result = evaluateConversationStep(withService);
    expect(result.json.service).toBe('Baldosas');
    expect(result.json.current_step).toContain('requirement');
  });

  test('requirement + confirm -> handoff_ready', () => {
    const withReq = {
      ...baseInput,
      has_active_conversation: true,
      conversation_id: 1,
      conversation_status_code: 'waiting_user',
      current_step: 'requirement',
      state_current_step: 'requirement',
      city: 'Santiago',
      state_city: 'Santiago',
      service: 'Baldosas',
      state_service: 'Baldosas',
      state_requirement: 'Necesito 100m2 para patio',
      text_body: 'Necesito 100m2 para patio',
    };
    let result = evaluateConversationStep(withReq);
    expect(result.json.requirement).toBe('Necesito 100m2 para patio');
    expect(result.json.current_step).toBe('confirm');
    expect(result.json.response_kind).toBe('confirmation_question');

    // Confirm
    const { state_current_step: _, ...confirmedBase } = withReq;
    const confirmed = { ...confirmedBase, current_step: 'confirm', text_body: 'Sí, está correcto' };
    result = evaluateConversationStep(confirmed);
    expect(result.json.should_create_lead).toBe(true);
    expect(result.json.response_kind).toBe('handoff_ready');
    expect(result.json.conversation_status_code).toBe('handed_to_sales');
  });

  test('RE-ENGAGEMENT: >48h and <=30d -> previous_context consent (preserves identity)', () => {
    const reengagementInput = {
      ...baseInput,
      has_existing_conversation: true,
      is_recent_conversation: false,
      is_stale_context: true,
      has_active_conversation: false,
      conversation_id: 1,
      target_conversation_id: 1,
      conversation_status_code: 'waiting_user',
      elapsed_hours_since_last_inbound: 72,
      is_reengagement: true,
      has_pending_followups: false,
      last_known_service: 'Baldosas',
      last_known_city: 'Santiago',
      text_body: 'Hola de nuevo',
    };
    const result = evaluateConversationStep(reengagementInput);
    expect(result.json.response_kind).toBe('previous_context_choice');
    expect(result.json.current_step).toBe('previous_context');
    expect(result.json.conversation_id).toBe(1);
    expect(result.json.target_conversation_id).toBe(1);
    expect(result.json.reset_conversation_lead).toBe(false);
    expect(result.json.used_previous_context).toBe(false);
    expect(result.json.service).toBeNull();
    expect(result.json.city).toBeNull();
    expect(result.json.requirement).toBeNull();
  });

  test('pending follow-ups do not imply delivered-message copy', () => {
    const result = evaluateConversationStep({
      ...baseInput,
      has_existing_conversation: true,
      is_recent_conversation: false,
      is_stale_context: true,
      has_active_conversation: false,
      conversation_id: 1,
      target_conversation_id: 1,
      is_reengagement: true,
      has_pending_followups: true,
      text_body: 'Hola',
    });
    expect(result.json.deterministic_reply).not.toMatch(/mensajes previos|escribimos varias veces/i);
  });

  test('PRECEDENCE: opt-out wins over re-engagement', () => {
    const input = {
      ...baseInput,
      has_active_conversation: false,
      conversation_id: 1,
      conversation_status_code: 'waiting_user',
      elapsed_hours_since_last_inbound: 72,
      is_reengagement: true,
      has_pending_followups: false,
      text_body: 'No me escribas más',
    };
    const result = evaluateConversationStep(input);
    // Opt-out triggers escalation_routing (precedence 1)
    expect(result.json.should_escalate).toBe(true);
    expect(result.json.escalation_reason).toBe('opt_out');
    expect(result.json.response_kind).toBe('escalation_routing');
  });

  test('PRECEDENCE: human request wins over re-engagement', () => {
    const input = {
      ...baseInput,
      has_active_conversation: false,
      conversation_id: 1,
      conversation_status_code: 'waiting_user',
      elapsed_hours_since_last_inbound: 72,
      is_reengagement: true,
      has_pending_followups: false,
      text_body: 'Quiero hablar con una persona',
    };
    const result = evaluateConversationStep(input);
    expect(result.json.should_escalate).toBe(true);
    expect(result.json.escalation_reason).toBe('human_requested');
    expect(result.json.response_kind).toBe('escalation_routing');
  });

  test('PRECEDENCE: operational (continuar anterior) wins over new request', () => {
    const input = {
      ...baseInput,
      has_active_conversation: true,
      conversation_id: 1,
      conversation_status_code: 'waiting_user',
      previous_lead_id: 1,
      previous_service: 'Baldosas',
      previous_city: 'Santiago',
      previous_requirement: '100m2',
      text_body: 'Quiero continuar con la anterior',
    };
    const result = evaluateConversationStep(input);
    expect(result.json.used_previous_context).toBe(true);
    expect(result.json.service).toBe('Baldosas');
    expect(result.json.city).toBe('Santiago');
    expect(result.json.requirement).toBe('100m2');
    expect(result.json.response_kind).toBe('previous_context_resumed');
  });

  test('>30d since last inbound -> new request (not re-engagement)', () => {
    const input = {
      ...baseInput,
      has_active_conversation: false,
      conversation_id: 1,
      conversation_status_code: 'waiting_user',
      elapsed_hours_since_last_inbound: 31 * 24, // beyond 30 days
      is_reengagement: false, // SQL returns false for >30d
      text_body: 'Hola',
    };
    const result = evaluateConversationStep(input);
    expect(result.json.response_kind).toBe('welcome_and_question'); // new request flow
    expect(result.json.reset_conversation_lead).toBe(true);
    expect(result.json.conversation_id).toBeNull();
  });

  test('frustration detection -> escalation_routing', () => {
    const input = {
      ...baseInput,
      has_active_conversation: true,
      conversation_id: 1,
      conversation_status_code: 'waiting_user',
      current_step: 'city',
      state_current_step: 'city',
      text_body: 'No me escuchas, que lata',
    };
    const result = evaluateConversationStep(input);
    expect(result.json.should_escalate).toBe(true);
    expect(result.json.escalation_reason).toBe('frustration_detected');
    expect(result.json.response_kind).toBe('escalation_routing');
  });

  test('B2B detection -> b2b_redirect', () => {
    const input = {
      ...baseInput,
      has_active_conversation: true,
      conversation_id: 1,
      conversation_status_code: 'waiting_user',
      current_step: 'service',
      state_current_step: 'service',
      city: 'Santiago',
      state_city: 'Santiago',
      text_body: 'Somos una constructora, necesitamos OC',
    };
    const result = evaluateConversationStep(input);
    expect(result.json.response_kind).toBe('b2b_redirect');
    expect(result.json.deterministic_reply).toContain('constructora');
  });

  test('metadata includes reengagement structured logging', () => {
    const reengagementInput = {
      ...baseInput,
      has_active_conversation: false,
      conversation_id: 1,
      conversation_status_code: 'waiting_user',
      elapsed_hours_since_last_inbound: 72,
      is_reengagement: true,
      has_pending_followups: false,
      text_body: 'Hola',
    };
    const result = evaluateConversationStep(reengagementInput);
    const meta = JSON.parse(result.json.metadata_json);
    expect(meta.reengagement_stage).toBe('detected');
    expect(meta.reengagement_decision).toBe('previous_context_choice');
    expect(meta.reengagement_elapsed_hours).toBe(72);
  });

  // ===========================================================================
  // Concrete requirement answers (memoria #668)
  // ---------------------------------------------------------------------------
  // A measurement or a quantity is the most precise answer a customer can give
  // at the requirement step, yet it is only two or three words long. Rejecting
  // it re-asks a question the customer already answered and, from the third
  // turn on, escalates the conversation as `loop_detected`.
  // ===========================================================================
  const requirementTurn = (textBody, step = 'requirement') => ({
    ...baseInput,
    has_active_conversation: true,
    conversation_id: 1,
    conversation_status_code: 'waiting_user',
    current_step: step,
    state_current_step: step,
    city: 'Santiago',
    state_city: 'Santiago',
    service: 'Pastelones',
    state_service: 'Pastelones',
    pending_question_key: 'requirement',
    text_body: textBody,
  });

  test.each([
    '50 metros',
    '100 m2',
    '100 m²',
    '200 unidades',
    '80 metros lineales',
    '3 palets',
    '50m2',
    '1.000 m2',
    'necesito 50 metros',
  ])('measurement answer "%s" satisfies the requirement step', (textBody) => {
    const result = evaluateConversationStep(requirementTurn(textBody));
    expect(result.json.requirement).toBe(textBody);
    expect(result.json.current_step).toContain('confirm');
    expect(result.json.should_escalate).toBe(false);
  });

  test('a valid measurement never escalates as loop_detected', () => {
    const result = evaluateConversationStep(requirementTurn('80 metros lineales', 'requirement_retry_2'));
    expect(result.json.escalation_reason).not.toBe('loop_detected');
    expect(result.json.conversation_status_code).not.toBe('escalation_required');
  });

  test('a bare number without a unit keeps asking for the requirement', () => {
    const result = evaluateConversationStep(requirementTurn('50'));
    expect(result.json.requirement).toBeNull();
    expect(result.json.current_step).toContain('requirement');
  });
});
