import fs from 'node:fs';
import { describe, expect, test } from 'vitest';
import { evaluateConversationStep } from '../fixtures/workflow-nodes/wa-conversation-orchestrator/evaluate-conversation-step.js';

const buildPath = 'tests/fixtures/workflow-nodes/ai-lead-qualification-assistant/build-ai-request.js';
const applyPath = 'tests/fixtures/workflow-nodes/wa-conversation-orchestrator/apply-ai-assistance.js';
const preparePath = 'tests/fixtures/workflow-nodes/wa-conversation-orchestrator/prepare-conversation-output.js';

const runCodeNode = (source, items, env = {}) => new Function('items', '$env', source)(items, env);

const ownedTurn = {
  phone_number: '56911111111',
  input_source_number_id: 7,
  input_whatsapp_name: 'Customer',
  input_external_message_id: 'customer-owned-1',
  message_type: 'text',
  text_body: 'Además necesito despacho',
  raw_payload_json: '{}',
  inbound_event_id: 901,
  processing_token: 'claim-owned',
  conversation_id: 101,
  target_conversation_id: 101,
  lead_id: 202,
  previous_lead_id: 202,
  ownership_id: 303,
  ownership_lead_id: 202,
  bot_suppressed: true,
  human_response_due_at: '2026-09-09T18:00:00.000Z',
  human_arbitration_required: false,
  has_existing_conversation: true,
  is_recent_conversation: true,
  is_stale_context: false,
  has_active_conversation: true,
  conversation_status_code: 'waiting_user',
  current_step: 'confirm',
  state_service: 'Baldosas',
  state_city: 'Santiago',
  state_requirement: 'Patio',
  qualification_context: { modality: 'delivery' },
  pending_question_key: 'final_confirmation',
  recent_messages: [],
};

describe('human-owned conversation turn', () => {
  test('persists a silent turn without advancing qualification or creating effects', () => {
    const output = evaluateConversationStep(ownedTurn).json;

    expect(output).toMatchObject({
      ownership_id: 303,
      ownership_lead_id: 202,
      bot_suppressed: true,
      should_create_lead: false,
      should_escalate: false,
      response_text: '',
      deterministic_reply: '',
      response_kind: 'human_control_suppressed',
      current_step: 'confirm',
      service: 'Baldosas',
      city: 'Santiago',
      requirement: 'Patio',
      pending_question_key: 'final_confirmation',
    });
  });

  test('does not build or call Gemini while human control is active', () => {
    const evaluated = evaluateConversationStep(ownedTurn).json;
    const output = runCodeNode(fs.readFileSync(buildPath, 'utf8'), [{ json: evaluated }], {
      AI_LEAD_ASSISTANT_ENABLED: 'true',
      AI_DIRECT_API_KEY: 'configured-key',
      AI_DIRECT_API_MODEL: 'gemini-test',
    });

    expect(output[0].json.ai_skipped).toBe(true);
    expect(output[0].json.ai_skip_reason).toBe('human_control_active');
    expect(output[0].json.ai_request).toBeNull();
  });

  test('keeps the final response and all automated effects empty after the merge', () => {
    const evaluated = evaluateConversationStep(ownedTurn).json;
    const applied = runCodeNode(fs.readFileSync(applyPath, 'utf8'), [{
      json: {
        ...evaluated,
        ai_skipped: true,
        ai_skip_reason: 'human_control_active',
      },
    }], { AI_LEAD_ASSISTANT_ENABLED: 'true' });

    expect(applied[0].json).toMatchObject({
      response_text: '',
      response_kind: 'human_control_suppressed',
      should_create_lead: false,
      ai_invoked: false,
      ai_applied: false,
    });

    const prepared = runCodeNode(fs.readFileSync(preparePath, 'utf8'), [{
      json: { ...applied[0].json, conversation_id_1: 101 },
    }]);
    expect(prepared[0].json).toMatchObject({
      bot_suppressed: true,
      ownership_lead_id: 202,
      response_text: null,
    });
  });
});
