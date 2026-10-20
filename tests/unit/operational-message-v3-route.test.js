import { describe, expect, test } from 'vitest';
import { evaluateConversationStep } from '../fixtures/workflow-nodes/wa-conversation-orchestrator/evaluate-conversation-step.js';

// Live test 2026-10-20 (s13): "¿Los productos tienen garantía?" and "¿Pueden
// hacer factura?" were answered "No pude procesar tu respuesta". An operational
// message (invoice, warranty, payment, claim) was marked v3_control_only, so it
// skipped the v3.1 advisor and fell to the legacy fallback copy. The branch is
// there so the AI classifies and routes it; under v3 that AI is v3.1.

const activeConversation = {
  phone_number: '56900000000',
  input_source_number_id: 7,
  message_type: 'text',
  inbound_event_id: 9001,
  processing_token: 'claim-token',
  conversation_id: 101,
  target_conversation_id: 101,
  has_existing_conversation: true,
  is_recent_conversation: true,
  is_stale_context: false,
  has_active_conversation: true,
  is_reengagement: false,
  conversation_status_code: 'waiting_user',
  current_step: 'city',
  qualification_context: {},
  recent_messages: [],
};

describe('operational messages reach the v3.1 advisor', () => {
  test.each([
    '¿Pueden hacer factura?',
    '¿Los productos tienen garantía?',
    'Ya hice la transferencia, ¿a dónde mando el comprobante?',
    'Lo necesito con factura, mi RUT es 76.123.456-7',
    'Tengo un reclamo por la instalación',
  ])('%s', (text_body) => {
    const output = evaluateConversationStep({ ...activeConversation, text_body }).json;
    expect(output.response_kind).toBe('operational_passthrough');
    expect(output.v3_control_only).toBe(false);
  });
});
