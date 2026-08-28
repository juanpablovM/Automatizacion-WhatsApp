import fs from 'node:fs';
import { describe, expect, test } from 'vitest';

const applyPath = 'tests/fixtures/workflow-nodes/wa-conversation-orchestrator/apply-ai-assistance.js';

const runCodeNode = (source, items, env = {}) => new Function('items', '$env', source)(items, env);

// A turn that is escalating for an operational reason. The AI reply is
// irrelevant here: escalation copy is deterministic policy and must not be
// overwritten by the model.
const baseRow = {
  conversation_id: 150,
  target_conversation_id: 150,
  original_conversation_id: 150,
  current_step: 'requirement',
  conversation_status_code: 'active',
  response_kind: 'ai_assisted_question',
  qualification_context: {},
  should_create_lead: false,
  should_escalate: true,
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

// The client only "repeated themselves" when the escalation was triggered by a
// loop. Saying it on any other route tells the client something that did not
// happen — observed in test conversation 150, where a first-time B2B tender
// enquiry was answered with "No quiero hacerte repetir lo mismo".
const CLAIMS_REPETITION = /repetir lo mismo/i;

describe('escalation copy matches the reason the turn escalated', () => {
  test('a confirmation rejection loop keeps the repetition wording: it is true there', () => {
    const output = runApply({ escalation_reason: 'confirmation_rejection_loop' });

    expect(output.response_kind).toBe('escalation_routing');
    expect(output.response_text).toMatch(CLAIMS_REPETITION);
  });

  test('a B2B enquiry does not claim the client repeated themselves', () => {
    const output = runApply({ escalation_area: 'b2b', customer_type: 'b2b' });

    expect(output.response_kind).toBe('escalation_routing');
    expect(output.response_text).not.toMatch(CLAIMS_REPETITION);
    expect(output.response_text.length).toBeGreaterThan(0);
  });

  test('a client asking for a human does not claim they repeated themselves', () => {
    const output = runApply({ escalation_reason: 'human_requested' });

    expect(output.response_kind).toBe('escalation_routing');
    expect(output.response_text).not.toMatch(CLAIMS_REPETITION);
    expect(output.response_text.length).toBeGreaterThan(0);
  });

  test('an unmapped operational area still gets truthful copy, never silence', () => {
    const output = runApply({ escalation_area: 'post_sale' });

    expect(output.response_kind).toBe('escalation_routing');
    expect(output.response_text).not.toMatch(CLAIMS_REPETITION);
    expect(output.response_text.length).toBeGreaterThan(0);
  });

  test('every escalation route still announces that a person will take over', () => {
    const routes = [
      { escalation_reason: 'confirmation_rejection_loop' },
      { escalation_area: 'b2b', customer_type: 'b2b' },
      { escalation_reason: 'human_requested' },
      { escalation_area: 'post_sale' },
    ];

    for (const route of routes) {
      const output = runApply(route);
      expect(output.response_text).toMatch(/persona del equipo|asesor|equipo/i);
    }
  });
});
