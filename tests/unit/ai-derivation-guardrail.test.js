import fs from 'node:fs';
import { describe, expect, test } from 'vitest';

const applyPath = 'tests/fixtures/workflow-nodes/wa-conversation-orchestrator/apply-ai-assistance.js';

const runCodeNode = (source, items, env = {}) => new Function('items', '$env', source)(items, env);

// Base turn where the AI is healthy, no lead is being created, and no
// escalation/handoff is in progress. Reproduces the shape of the three
// 21/08 conversations from memoria #762 where the AI promised derivation
// without CRM - Lead Creation And Assignment ever being invoked.
const baseRow = {
  conversation_id: 101,
  target_conversation_id: 101,
  original_conversation_id: 101,
  // Fields left unset on purpose: hasRequiredLeadFields must be false so the
  // separate advisor-guardrail-question override (line ~1144, unrelated to
  // this fix) does not pre-empt selectResponseText()'s pick before it runs —
  // matches the real 21/08 conversations, all early-stage (greeting/re-engagement).
  current_step: 'service',
  conversation_status_code: 'active',
  response_kind: 'ai_assisted_question',
  qualification_context: {},
  should_create_lead: false,
  should_escalate: false,
  escalation_reason: '',
  escalation_area: '',
  intent: 'provide_info',
  confidence: 0.9,
  commercial_missing_fields: [],
  catalog_matches: [],
  price_context: {},
  objection_detected: 'none',
  customer_type: '',
  lead_class: '',
};

const runApply = (overrides) => runCodeNode(
  fs.readFileSync(applyPath, 'utf8'),
  [{ json: { ...baseRow, ...overrides } }],
  {},
)[0].json;

describe('AI derivation guardrail (memoria #762)', () => {
  test('blocks a false derivation promise when no lead/escalation is happening', () => {
    const output = runApply({
      reply_text: 'Perfecto, con esos datos voy a derivar tu caso a un asesor para que te contacte.',
    });
    expect(output.response_kind).toBe('prd_validated_fallback');
    expect(output.response_text).not.toMatch(/voy a derivar|he derivado/i);
  });

  test('blocks the exact phrasing reported in production ("He derivado tu caso")', () => {
    const output = runApply({
      reply_text: 'Listo, he derivado tu caso, en breve te contactará un ejecutivo.',
    });
    expect(output.response_kind).toBe('prd_validated_fallback');
  });

  test('does not block ordinary AI replies that never mention derivation', () => {
    const replyText = '¿Me confirmas la comuna donde necesitas el despacho?';
    const output = runApply({ reply_text: replyText });
    expect(output.response_text).toBe(replyText);
    expect(output.response_kind).not.toBe('prd_validated_fallback');
  });

  test('does not interfere with a genuine lead-creation turn (PRIORITY 1)', () => {
    const output = runApply({
      should_create_lead: true,
      // modality 'pickup' resolves to the 'retiro' profile, which only
      // requires 'product' (satisfied below) — the commercial gate must not
      // silently downgrade should_create_lead to false for this scenario.
      qualification_context: { modality: 'pickup', product: 'Baldosas' },
      reply_text: 'Perfecto, voy a derivar tu caso a un asesor para que te contacte.',
    });
    // PRIORITY 1 always discards ai.reply_text once validation passes; a
    // real derivation here must not be reinterpreted as a false promise.
    expect(output.response_kind).toBe('handoff_pending');
    expect(output.response_text).toBe('');
  });
});
