import fs from 'node:fs';
import { describe, expect, test } from 'vitest';

const fixturePath = 'tests/fixtures/workflow-nodes/ai-lead-qualification-assistant/build-ai-request.js';

const runCodeNode = (source, items, env = {}) => new Function('items', '$env', source)(items, env);

// This fixture has no exported functions and no import-time guard at all —
// `items`/`$env` are read at module top level, so `require`/`import` throws
// immediately. It had zero test coverage of any kind before this file
// (confirmed: no test in this repo referenced it).
describe('Build AI Request — real n8n Code node wrapper', () => {
  test('skips the AI request entirely when the assistant is disabled by env', () => {
    const source = fs.readFileSync(fixturePath, 'utf8');
    const output = runCodeNode(source, [{ json: { text_body: 'Hola' } }], {
      AI_LEAD_ASSISTANT_ENABLED: 'false',
    });

    expect(output).toHaveLength(1);
    expect(output[0].json.ai_skipped).toBe(true);
    expect(output[0].json.ai_skip_reason).toBe('disabled');
    expect(output[0].json.ai_request).toBeNull();
  });

  test('reports a configuration error instead of a request when the API key/model are missing', () => {
    const source = fs.readFileSync(fixturePath, 'utf8');
    const output = runCodeNode(source, [{ json: { text_body: 'Hola' } }], {
      AI_DIRECT_API_KEY: '__PENDIENTE__',
    });

    expect(output[0].json.ai_skipped).toBe(false);
    expect(output[0].json.ai_request).toBeNull();
    expect(output[0].json.ai_request_error).toBe('missing_api_config');
  });

  test('builds a real chat-completions request payload carrying the customer message', () => {
    const source = fs.readFileSync(fixturePath, 'utf8');
    const output = runCodeNode(source, [{
      json: { text_body: 'Hola, necesito baldosas para mi patio' },
    }], {
      AI_DIRECT_API_KEY: 'fake-key-123',
      AI_DIRECT_API_MODEL: 'gemini-2.0-flash',
      AI_PROVIDER: 'google',
    });

    expect(output[0].json.ai_skipped).toBe(false);
    expect(output[0].json.ai_request_error).toBeUndefined();
    expect(output[0].json.ai_request.model).toBe('gemini-2.0-flash');
    expect(output[0].json.ai_request.messages).toBeInstanceOf(Array);
    expect(output[0].json.ai_request.messages[1].content).toContain('"message_current":"Hola, necesito baldosas para mi patio"');
  });

  test('preserves the v3 policy and repair attempt through the repair request', () => {
    const source = fs.readFileSync(fixturePath, 'utf8');
    const turnPolicy = {
      version: 'ai_prd_turn_policy/v3',
      policy_digest: 'a'.repeat(64),
      state_authority: { allowed_mutations: [] },
      effect_authority: { permissions: [] },
    };
    const repairRequest = {
      schema: 'ai_conversation_repair_request/v3',
      policy_digest: turnPolicy.policy_digest,
      complete_repair: true,
      repair_attempt: 1,
      errors: [{ code: 'proposal_shape_invalid', path: '$' }],
    };
    const output = runCodeNode(source, [{
      json: {
        contract_version: 'v3',
        turn_policy: turnPolicy,
        v3_policy: turnPolicy,
        v3_repair_attempt: 1,
        ai_repair_request: repairRequest,
      },
    }], {
      AI_DIRECT_API_KEY: 'fake-key-123',
      AI_DIRECT_API_MODEL: 'test-model',
    });

    expect(output[0].json.turn_policy).toEqual(turnPolicy);
    expect(output[0].json.v3_policy).toEqual(turnPolicy);
    expect(output[0].json.v3_repair_attempt).toBe(1);
    expect(output[0].json.ai_repair_request).toEqual(repairRequest);
  });

  test('sends the repair request that arrives suffixed by the commercial merge', () => {
    // `Merge Commercial Context` combines with `addSuffix`, so on the repair
    // cycle this node receives `ai_repair_request_1`, never the bare name. Every
    // other v3 field here already reads through `pickMerged`; this one did not,
    // so the second provider call went out identical to the first — no
    // `repair_request` in the prompt — and the model had nothing to repair from.
    // Asserting the field survives on the output is not enough: what matters is
    // what reaches the provider.
    const source = fs.readFileSync(fixturePath, 'utf8');
    const turnPolicy = {
      version: 'ai_prd_turn_policy/v3',
      policy_digest: 'b'.repeat(64),
      state_authority: { allowed_mutations: [] },
      effect_authority: { permissions: [] },
    };
    const repairRequest = {
      schema: 'ai_conversation_repair_request/v3',
      policy_digest: turnPolicy.policy_digest,
      complete_repair: true,
      repair_attempt: 1,
      errors: [{ code: 'proposal_shape_invalid', path: '$' }],
    };
    const output = runCodeNode(source, [{
      json: {
        contract_version_1: 'v3',
        turn_policy_1: turnPolicy,
        v3_repair_attempt_1: 1,
        ai_repair_request_1: repairRequest,
      },
    }], {
      AI_DIRECT_API_KEY: 'fake-key-123',
      AI_DIRECT_API_MODEL: 'test-model',
    });

    expect(output[0].json.ai_request_error).toBeUndefined();
    const userPrompt = output[0].json.ai_request.messages
      .find(({ role }) => role === 'user').content;
    expect(JSON.parse(userPrompt).repair_request).toEqual(repairRequest);
  });
});
