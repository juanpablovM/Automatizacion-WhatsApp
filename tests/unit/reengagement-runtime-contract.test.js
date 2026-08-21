import fs from 'node:fs';
import { describe, expect, test } from 'vitest';
import { evaluateConversationStep } from '../fixtures/workflow-nodes/wa-conversation-orchestrator/evaluate-conversation-step.js';

const fixturePath = 'tests/fixtures/workflow-nodes/wa-conversation-orchestrator/evaluate-conversation-step.js';
const applyPath = 'tests/fixtures/workflow-nodes/wa-conversation-orchestrator/apply-ai-assistance.js';
const preparePath = 'tests/fixtures/workflow-nodes/wa-conversation-orchestrator/prepare-conversation-output.js';
const sqlPath = 'db/queries/n8n/wa-conversation-orchestrator/01_load_active_context.sql';
const workflowPath = 'n8n/workflows/wa-conversation-orchestrator.json';

const base = {
  phone_number: 'test-contact-001',
  input_source_number_id: 7,
  input_whatsapp_name: 'Test User',
  input_external_message_id: 'message-001',
  message_type: 'text',
  text_body: 'Hola',
  raw_payload_json: '{}',
  inbound_event_id: 9001,
  processing_token: 'claim-token',
  conversation_id: 101,
  target_conversation_id: 101,
  lead_id: 202,
  has_existing_conversation: true,
  is_recent_conversation: false,
  is_stale_context: true,
  has_active_conversation: false,
  is_reengagement: true,
  elapsed_hours_since_last_inbound: 72,
  conversation_status_code: 'waiting_user',
  previous_lead_id: 202,
  previous_service: 'Baldosas',
  previous_city: 'Santiago',
  previous_requirement: 'Patio',
  last_known_service: 'Baldosas',
  last_known_city: 'Santiago',
  last_known_requirement: 'Patio',
  qualification_context: {},
  recent_messages: [],
};

const runCodeNode = (source, items, env = {}) => new Function('items', '$env', source)(items, env);

describe('re-engagement runtime contract', () => {
  test('the embedded Code node wrapper explicitly returns items', () => {
    const workflow = JSON.parse(fs.readFileSync(workflowPath, 'utf8'));
    const embeddedCode = workflow.nodes.find((node) => node.name === 'Evaluate Conversation Step').parameters.jsCode;
    const output = runCodeNode(embeddedCode, [{ json: base }]);
    expect(output).toHaveLength(1);
    expect(output[0].json.response_kind).toBe('previous_context_choice');
  });

  test('re-engagement asks for consent without preloading previous fields', () => {
    const output = evaluateConversationStep(base).json;
    expect(output).toMatchObject({
      conversation_id: 101,
      target_conversation_id: 101,
      original_conversation_id: 101,
      current_step: 'previous_context',
      pending_question_key: 'previous_context_choice',
      response_kind: 'previous_context_choice',
      reset_conversation_lead: false,
      used_previous_context: false,
      service: null,
      city: null,
      requirement: null,
    });
  });

  test('opt-out wins over resume and keeps the policy target identity', () => {
    const output = evaluateConversationStep({
      ...base,
      text_body: 'Quiero retomar la solicitud anterior pero no me escribas más',
    }).json;
    expect(output.escalation_reason).toBe('opt_out');
    expect(output.conversation_status_code).toBe('closed');
    expect(output.target_conversation_id).toBe(101);
  });

  test.each([
    'Necesito una factura de mi compra',
    'Quiero revisar la garantía del producto',
    'Adjunto el comprobante de pago',
    'Tengo un reclamo por la instalación',
  ])('operational message bypasses re-engagement greeting: %s', (text_body) => {
    const output = evaluateConversationStep({ ...base, text_body }).json;
    expect(output.response_kind).toBe('operational_passthrough');
    expect(output.current_step).not.toBe('previous_context');
    expect(output.target_conversation_id).toBe(101);
  });

  test('terminal status wins over re-engagement and starts a new request', () => {
    const output = evaluateConversationStep({
      ...base,
      conversation_status_code: 'closed',
      text_body: 'Hola',
    }).json;
    expect(output.response_kind).toBe('new_request_started');
    expect(output.reset_conversation_lead).toBe(true);
    expect(output.conversation_id).toBeNull();
    expect(output.target_conversation_id).toBe(101);
  });

  test('an escalated conversation can explicitly start a new request', () => {
    const output = evaluateConversationStep({
      ...base,
      conversation_status_code: 'escalation_required',
      current_step: 'escalation',
      state_current_step: 'escalation',
      is_reengagement: false,
      text_body: 'Nueva cotización',
    }).json;
    expect(output.response_kind).toBe('new_request_started');
    expect(output.reset_conversation_lead).toBe(true);
    expect(output.conversation_id).toBeNull();
    expect(output.target_conversation_id).toBe(101);
    expect(output.should_escalate).toBe(false);
  });

  test('stale context beyond 30 days starts a new request but retains policy target', () => {
    const output = evaluateConversationStep({
      ...base,
      is_reengagement: false,
      elapsed_hours_since_last_inbound: 31 * 24,
      text_body: 'Hola',
    }).json;
    expect(output.reset_conversation_lead).toBe(true);
    expect(output.conversation_id).toBeNull();
    expect(output.target_conversation_id).toBe(101);
    expect(output.response_kind).toBe('welcome_and_question');
  });

  test('Apply AI Assistance and output preparation preserve the policy target', () => {
    const deterministic = evaluateConversationStep(base).json;
    const applied = runCodeNode(
      fs.readFileSync(applyPath, 'utf8'),
      [{ json: { ...deterministic, ai_skipped: true, ai_fallback_reason: 'test' } }],
      { AI_LEAD_ASSISTANT_ENABLED: 'false', AI_MODEL_C_ENABLED: 'false' },
    );
    expect(applied[0].json.target_conversation_id).toBe(101);
    expect(applied[0].json.response_kind).toBe('previous_context_choice');

    const prepared = runCodeNode(fs.readFileSync(preparePath, 'utf8'), [{
      json: { ...applied[0].json, conversation_id_1: 303 },
    }]);
    expect(prepared[0].json.conversation_id).toBe(303);
    expect(prepared[0].json.target_conversation_id).toBe(101);
  });

  test('source SQL is the exact embedded query and encodes one temporal contract', () => {
    const sql = fs.readFileSync(sqlPath, 'utf8');
    const workflow = JSON.parse(fs.readFileSync(workflowPath, 'utf8'));
    const embedded = workflow.nodes.find((node) => node.name === 'Load Conversation State').parameters.query;
    expect(embedded).toBe(sql);
    expect(sql).toContain("ie.processing_status = 'processed'");
    expect(sql).toContain("INTERVAL '48 hours'");
    expect(sql).toContain("INTERVAL '30 days'");
    expect(sql).toContain("lc.conversation_status_code IN ('active', 'waiting_user', 'out_of_flow')");
    expect(sql).not.toMatch(/conversation_status_id\s+IN\s*\(/);
    expect(sql).not.toContain("'claimed'");
  });
});
