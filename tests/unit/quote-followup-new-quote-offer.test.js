import fs from 'node:fs';
import { describe, expect, test } from 'vitest';
import {
  evaluateConversationStep,
  QUOTE_FOLLOWUP_NEW_QUOTE_REPLY,
} from '../fixtures/workflow-nodes/wa-conversation-orchestrator/evaluate-conversation-step.js';

// Migration 037: the quote follow-up notice ends with "¿Quieres hacer una
// cotización nueva?" while the seller still owns the chat. The next customer
// message answers it deterministically: a yes starts a new quote (new
// conversation, the seller's ownership of the old quote released); anything
// else stays silent for the seller. The AI is never asked.

const applyPath = 'tests/fixtures/workflow-nodes/wa-conversation-orchestrator/apply-ai-assistance.js';
const preparePath = 'tests/fixtures/workflow-nodes/wa-conversation-orchestrator/prepare-conversation-output.js';
const runCodeNode = (source, items, env = {}) => new Function('items', '$env', source)(items, env);

const offeredTurn = (overrides = {}) => ({
  phone_number: '56911111111',
  input_source_number_id: 7,
  input_whatsapp_name: 'Customer',
  input_external_message_id: 'customer-offer-1',
  message_type: 'text',
  text_body: 'Sí',
  raw_payload_json: '{}',
  inbound_event_id: 901,
  processing_token: 'claim-offer',
  conversation_id: 101,
  target_conversation_id: 101,
  lead_id: 202,
  previous_lead_id: 202,
  ownership_id: 303,
  ownership_lead_id: 202,
  bot_suppressed: true,
  quote_followup_offer_pending: true,
  human_arbitration_required: false,
  has_existing_conversation: true,
  is_recent_conversation: true,
  is_stale_context: false,
  has_active_conversation: false,
  conversation_status_code: 'handed_to_sales',
  current_step: 'complete',
  state_service: 'Adoquines',
  state_city: 'Maipú',
  state_requirement: '50 m2',
  lead_clickup_task_id: 'task-1',
  lead_clickup_status: 'cotización enviada',
  qualification_context: { products: ['adoquin'] },
  pending_question_key: null,
  recent_messages: [{ role: 'assistant', text: 'aviso' }],
  ...overrides,
});

const metadataOf = (output) => JSON.parse(output.metadata_json);

describe('answer to the new-quote offer', () => {
  test.each([
    'Sí', 'si', 'Sí, por favor', 'dale', 'ok', 'Bueno', 'Claro que sí', 'sí quiero',
    'Quiero otra', 'Nueva cotización', 'Sí, quiero una cotización nueva', 'quiero cotizar otra cosa',
    'Sí\nquiero otra cotización',
  ])('%j starts a new quote', (text) => {
    const out = evaluateConversationStep(offeredTurn({ text_body: text })).json;
    expect(out).toMatchObject({
      response_kind: 'quote_followup_new_quote',
      deterministic_reply: QUOTE_FOLLOWUP_NEW_QUOTE_REPLY,
      bot_suppressed: false,
      reset_conversation_lead: true,
      conversation_id: null,
      lead_id: null,
      v3_control_only: true,
      should_create_lead: false,
      should_escalate: false,
      qualification_context: {},
      recent_messages: [],
      pending_question_key: null,
      ownership_lead_id: 202,
    });
    expect(metadataOf(out)).toMatchObject({
      response_kind: 'quote_followup_new_quote',
      release_quote_followup_ownership: true,
    });
  });

  test.each([
    'No', 'no gracias', '¿Cuándo me llega?', 'Sí, pero ¿y mi pedido?', 'Hola', 'Quiero hablar con Juan Pablo',
    'ok gracias, espero', '👍',
  ])('%j stays silent for the seller', (text) => {
    const out = evaluateConversationStep(offeredTurn({ text_body: text })).json;
    expect(out).toMatchObject({
      bot_suppressed: true,
      reset_conversation_lead: false,
      conversation_id: 101,
      lead_id: 202,
      deterministic_reply: '',
      should_create_lead: false,
    });
    expect(out.response_kind).not.toBe('quote_followup_new_quote');
    expect(metadataOf(out).release_quote_followup_ownership).toBeFalsy();
  });

  test('a yes without a pending offer is just another message to the seller', () => {
    const out = evaluateConversationStep(offeredTurn({ quote_followup_offer_pending: false })).json;
    expect(out).toMatchObject({ response_kind: 'human_control_suppressed', bot_suppressed: true, deterministic_reply: '' });
  });

  test('the reply survives the merge as a deterministic, AI-free turn and is sent', () => {
    const evaluated = evaluateConversationStep(offeredTurn()).json;
    const applied = runCodeNode(fs.readFileSync(applyPath, 'utf8'), [{
      json: { ...evaluated, ai_skipped: true, ai_skip_reason: 'v3_control_only' },
    }], { AI_LEAD_ASSISTANT_ENABLED: 'true' });
    expect(applied[0].json).toMatchObject({
      response_text: QUOTE_FOLLOWUP_NEW_QUOTE_REPLY,
      response_kind: 'quote_followup_new_quote',
      reset_conversation_lead: true,
      should_create_lead: false,
      ai_invoked: false,
      ai_applied: false,
      qualification_context_json: '{}',
    });
    expect(JSON.parse(applied[0].json.metadata_json).release_quote_followup_ownership).toBe(true);

    const prepared = runCodeNode(fs.readFileSync(preparePath, 'utf8'), [{
      json: { ...applied[0].json, conversation_id_1: 404 },
    }]);
    expect(prepared[0].json).toMatchObject({
      bot_suppressed: false,
      response_text: QUOTE_FOLLOWUP_NEW_QUOTE_REPLY,
    });
  });
});
