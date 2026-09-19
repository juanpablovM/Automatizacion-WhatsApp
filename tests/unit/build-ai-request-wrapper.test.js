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

  test('legacy prompt knows the fixed pickup address and excludes customer location fields', () => {
    const source = fs.readFileSync(fixturePath, 'utf8');
    const output = runCodeNode(source, [{ json: { text_body: '¿Dónde retiro?' } }], {
      AI_DIRECT_API_KEY: 'fake-key-123', AI_DIRECT_API_MODEL: 'test-model',
    });
    const prompt = output[0].json.ai_request.messages[0].content;
    expect(prompt).toContain('Portezuelo 1502, San Bernardo');
    expect(prompt).toContain('Comuna es obligatoria solo con despacho o B2B');
  });

  test('v3 prompt knows the fixed pickup address and forbids pickup location questions', () => {
    const source = fs.readFileSync(fixturePath, 'utf8');
    const turnPolicy = {
      version: 'ai_prd_turn_policy/v3', policy_digest: 'a'.repeat(64), facts: [], goals: [],
      state_authority: { allowed_mutations: [] }, effect_authority: { permissions: [] }, grounding: {},
    };
    const output = runCodeNode(source, [{ json: { contract_version: 'v3', turn_policy: turnPolicy } }], {
      AI_DIRECT_API_KEY: 'fake-key-123', AI_DIRECT_API_MODEL: 'test-model',
    });
    const prompt = output[0].json.ai_request.messages[0].content;
    expect(prompt).toContain('Portezuelo 1502, San Bernardo');
    expect(prompt).toContain('commune, address y la ubicación del proyecto son inaplicables');
  });
});
