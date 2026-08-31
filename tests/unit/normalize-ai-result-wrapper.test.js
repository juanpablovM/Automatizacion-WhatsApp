import fs from 'node:fs';
import { describe, expect, test } from 'vitest';

const fixturePath = 'tests/fixtures/workflow-nodes/ai-lead-qualification-assistant/normalize-ai-result.js';

const runCodeNode = (source, items, env = {}) => new Function('items', '$env', source)(items, env);

// No exported functions, no import-time guard — `items`/`$env` are read at
// module top level, so importing this file directly throws immediately. It
// had zero test coverage before this file (confirmed: no test in this repo
// referenced it), despite being the layer that interprets the raw model
// response into structured fields.
describe('Normalize AI Result — real n8n Code node wrapper', () => {
  test('parses a real chat-completions style model response into structured fields', () => {
    const source = fs.readFileSync(fixturePath, 'utf8');
    const modelPayload = {
      intent: 'provide_info',
      confidence: 0.9,
      service: 'Baldosas',
      city: 'Santiago',
      requirement: 'Patio',
      reply_text: '¿Me confirmas la comuna donde necesitas el despacho?',
      should_create_lead: false,
      confirmation_status: 'none',
    };

    const output = runCodeNode(source, [{
      json: {
        ai_status_code: 200,
        ai_response: { choices: [{ message: { content: JSON.stringify(modelPayload) } }] },
        ai_context: { message_current: 'Necesito baldosas para mi patio' },
      },
    }]);

    expect(output).toHaveLength(1);
    expect(output[0].json.service).toBe('Baldosas');
    expect(output[0].json.city).toBe('Santiago');
    expect(output[0].json.requirement).toBe('Patio');
    expect(output[0].json.reply_text).toBe(modelPayload.reply_text);
    expect(output[0].json.ai_parse_error).toBeNull();
  });

  test('falls back safely when the model response is not valid JSON', () => {
    const source = fs.readFileSync(fixturePath, 'utf8');
    const output = runCodeNode(source, [{
      json: {
        ai_status_code: 200,
        ai_response: { choices: [{ message: { content: 'not json at all' } }] },
      },
    }]);

    expect(output[0].json.ai_parse_error).toBeTruthy();
    expect(output[0].json.should_create_lead).toBe(false);
  });

  test('preserves the v3 policy and repair attempt after normalization', () => {
    const source = fs.readFileSync(fixturePath, 'utf8');
    const turnPolicy = { version: 'ai_prd_turn_policy/v3', policy_digest: 'b'.repeat(64) };
    const proposal = {
      version: 'ai_conversation_proposal/v3',
      policy_digest: turnPolicy.policy_digest,
      reply_text: 'Propuesta reparada',
      primary_request: null,
      observations: [],
      state_mutations: [],
      effect_requests: [],
    };
    const output = runCodeNode(source, [{
      json: {
        ai_contract_version: 'v3',
        turn_policy: turnPolicy,
        v3_policy: turnPolicy,
        v3_repair_attempt: 1,
        ai_status_code: 200,
        ai_response: { choices: [{ message: { content: JSON.stringify(proposal) } }] },
      },
    }]);

    expect(output[0].json.turn_policy).toEqual(turnPolicy);
    expect(output[0].json.v3_policy).toEqual(turnPolicy);
    expect(output[0].json.v3_repair_attempt).toBe(1);
    expect(output[0].json.ai_proposal).toEqual(proposal);
  });
});
