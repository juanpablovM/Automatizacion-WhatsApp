// Slice 2a (design.md task 2a.23/2a.24), dark: these four runtimes must
// accept the v3.1 artifact version strings alongside their existing v3 ones,
// so an in-flight v3 turn and a v3.1 turn both flow through the same saga,
// normalizer and shadow evaluator once Slice 2b's switch exists. Nothing in
// production emits v3.1 yet — these tests only prove the widened check.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const {
  buildV3RepairRequest, buildV3ContingencyDecision, planV3Recovery,
} = require('../fixtures/workflow-nodes/shared/v3-saga-runtime.js');

const v31Policy = (overrides = {}) => ({
  version: 'ai_prd_turn_policy/v3.1',
  policy_digest: 'digest-v31',
  turn: { id: 'turn-1', conversation_id: 'conversation-1' },
  ...overrides,
});

describe('v3-saga-runtime.js accepts v3.1 alongside v3 (2a.23/2a.24)', () => {
  test('buildV3ContingencyDecision no longer rejects a v3.1 policy', () => {
    expect(() => buildV3ContingencyDecision({
      policy: v31Policy(), reason: 'provider_outage', expectedSnapshotDigest: 'digest',
    })).not.toThrow();
  });

  test('buildV3RepairRequest accepts a v3.1 policy and its v3.1 validation result', () => {
    const repair = buildV3RepairRequest({
      policy: v31Policy(),
      validation: {
        version: 'conversation_validation_result/v3.1', valid: false,
        errors: [{ code: 'item_target_required', path: 'x' }],
      },
    });
    expect(repair.schema).toBe('ai_conversation_repair_request/v3');
    expect(repair.policy_digest).toBe('digest-v31');
  });

  test('planV3Recovery still resolves for a v3.1 policy', () => {
    const plan = planV3Recovery({
      policy: v31Policy(),
      validation: { version: 'conversation_validation_result/v3.1', valid: true },
      preTurnState: {},
    });
    expect(plan.action).toBe('resume');
  });
});

describe('normalize-delivery-result.js accepts v3.1 decisions (2a.23/2a.24)', () => {
  const runNormalizeNode = (row) => {
    const source = fs.readFileSync(
      'tests/fixtures/workflow-nodes/wa-outbound-messages/normalize-delivery-result.js', 'utf8',
    );
    return new Function('items', source)([{ json: row }])[0].json;
  };

  test('quarantines a failed v3.1 provider outcome for reconciliation, same as v3', () => {
    const result = runNormalizeNode({
      id: 901, statusCode: 400, body: { message: 'provider failure' },
      raw_payload: { version: 'validated_conversation_decision/v3.1' },
      idempotency_key: 'v31-delivery:exact',
    });
    expect(result.delivery_status).toBe('failed');
    expect(result.reconciliation_required).toBe(true);
  });
});

describe('normalize-ai-result.js recognizes a v3.1 turn_policy (2a.23/2a.24)', () => {
  test('takes the v3 proposal-parsing branch when only turn_policy carries the v3.1 version', () => {
    const source = fs.readFileSync(
      'tests/fixtures/workflow-nodes/ai-lead-qualification-assistant/normalize-ai-result.js', 'utf8',
    );
    const runCodeNode = (row) => new Function('items', '$env', source)([{ json: row }], {});
    const output = runCodeNode({
      // No ai_contract_version set — only the compiled policy identifies the
      // artifact family, exactly as a real turn would carry it.
      turn_policy: { version: 'ai_prd_turn_policy/v3.1' },
      ai_status_code: 200,
      ai_response: { output_text: JSON.stringify({ reply_text: 'Hola' }) },
    });

    expect(output[0].json.ai_proposal).toEqual({ reply_text: 'Hola' });
    expect(output[0].json.ai_contract_version).toBe('v3');
  });
});

describe('record-shadow-evaluation.js recognizes a v3.1 policy (2a.23/2a.24)', () => {
  test('evaluates a v3.1 policy through the real validator instead of reporting invalid_turn_policy', () => {
    const runtimeSource = fs.readFileSync(
      'tests/fixtures/workflow-nodes/shared/v3-contract-runtime.js', 'utf8',
    );
    const evaluatorSource = fs.readFileSync(
      'tests/fixtures/workflow-nodes/ai-prd-shadow-evaluator/record-shadow-evaluation.js', 'utf8',
    );
    const context = { v3_policy: v31Policy(), ai_proposal: {} };
    const items = [{ json: {} }];
    const recordShadowEvaluation = () => ({ ok: true, error: null, duration_ms: 0 });
    const dollarFn = (nodeName) => ({
      first: () => ({ json: nodeName === 'Prepare Shadow Evaluation' ? context : {} }),
    });
    const run = new Function(
      'items', '$', 'recordShadowEvaluation', 'module', 'require',
      `${runtimeSource}\n${evaluatorSource}`,
    );
    const output = run(items, dollarFn, recordShadowEvaluation, { exports: {} }, require);

    expect(output[0].json.shadow_audit.validation_status).not.toBe('not_evaluated');
    expect(output[0].json.shadow_audit.validation_error_codes).not.toContain('invalid_turn_policy');
  });
});
