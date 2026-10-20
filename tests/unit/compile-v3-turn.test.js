import fs from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';

// Slice 2b (design.md D7), dark: compile-v3-turn.js reads
// $env.AI_PRD_V3_LINE_ITEMS (disabled|canary|enabled) and
// $env.AI_PRD_V3_LINE_ITEMS_CANARY_PHONES on every v3 turn, mirroring the
// canary-phone pattern in resolve-conversation-contract-route.js:13-23. The
// default stays disabled, so nothing in production compiles v3.1 yet.
const nodeRequire = createRequire(import.meta.url);
const { compileV3TurnPolicy, digestObject } = nodeRequire(
  '../fixtures/workflow-nodes/shared/v3-contract-runtime.js',
);
const { buildV3PolicyInput } = nodeRequire(
  '../fixtures/workflow-nodes/shared/v3-policy-builder.js',
);

const fixturePath = 'tests/fixtures/workflow-nodes/wa-conversation-orchestrator/compile-v3-turn.js';

const runNode = (items, env = {}) => {
  const source = fs.readFileSync(fixturePath, 'utf8');
  return new Function(
    'items', '$env', 'compileV3TurnPolicy', 'buildV3PolicyInput', 'digestObject', source,
  )(items, env, compileV3TurnPolicy, buildV3PolicyInput, digestObject);
};

const v3Turn = (overrides = {}) => ({
  contract_version: 'v3',
  conversation_id: 1,
  inbound_event_id: 'turn-1',
  text_body: 'Hola',
  phone_number: '56990001111',
  ...overrides,
});

const versionOf = (output) => output[0].json.turn_policy.version;

describe('Compile V3 Turn Policy — the line-items rollout switch', () => {
  test('a non-v3 turn is passed through untouched, no switch read', () => {
    const output = runNode([{ json: { contract_version: 'legacy', text_body: 'Hola' } }], {
      AI_PRD_V3_LINE_ITEMS: 'enabled',
    });

    expect(output[0].json).toEqual({ contract_version: 'legacy', text_body: 'Hola' });
  });

  test('disabled (the default) compiles v3 for every phone', () => {
    const withoutEnv = runNode([{ json: v3Turn() }], {});
    const explicitlyDisabled = runNode([{ json: v3Turn({ phone_number: '56999999999' }) }], {
      AI_PRD_V3_LINE_ITEMS: 'disabled',
      AI_PRD_V3_LINE_ITEMS_CANARY_PHONES: '56999999999',
    });

    expect(versionOf(withoutEnv)).toBe('ai_prd_turn_policy/v3');
    expect(versionOf(explicitlyDisabled)).toBe('ai_prd_turn_policy/v3');
  });

  test('canary compiles v3.1 only for a phone listed in the canary set, else v3', () => {
    const listed = runNode([{ json: v3Turn({ phone_number: '+56 9 9000 1111' }) }], {
      AI_PRD_V3_LINE_ITEMS: 'canary',
      AI_PRD_V3_LINE_ITEMS_CANARY_PHONES: '56990001111,56911112222',
    });
    const unlisted = runNode([{ json: v3Turn({ phone_number: '56900000000' }) }], {
      AI_PRD_V3_LINE_ITEMS: 'canary',
      AI_PRD_V3_LINE_ITEMS_CANARY_PHONES: '56990001111,56911112222',
    });

    expect(versionOf(listed)).toBe('ai_prd_turn_policy/v3.1');
    expect(versionOf(unlisted)).toBe('ai_prd_turn_policy/v3');
  });

  test('canary with an empty phone list never promotes anyone', () => {
    const output = runNode([{ json: v3Turn() }], {
      AI_PRD_V3_LINE_ITEMS: 'canary',
      AI_PRD_V3_LINE_ITEMS_CANARY_PHONES: '',
    });

    expect(versionOf(output)).toBe('ai_prd_turn_policy/v3');
  });

  test('enabled compiles v3.1 for every phone, canary list or not', () => {
    const output = runNode([{ json: v3Turn({ phone_number: '56900000000' }) }], {
      AI_PRD_V3_LINE_ITEMS: 'enabled',
    });

    expect(versionOf(output)).toBe('ai_prd_turn_policy/v3.1');
  });

  test('an unknown switch value fails safe to disabled', () => {
    const output = runNode([{ json: v3Turn() }], { AI_PRD_V3_LINE_ITEMS: 'yolo' });

    expect(versionOf(output)).toBe('ai_prd_turn_policy/v3');
  });

  test('the policy digest still binds the compiled policy for both versions', () => {
    const disabled = runNode([{ json: v3Turn() }], { AI_PRD_V3_LINE_ITEMS: 'disabled' });
    const enabled = runNode([{ json: v3Turn() }], { AI_PRD_V3_LINE_ITEMS: 'enabled' });

    expect(disabled[0].json.policy_digest).toBe(disabled[0].json.turn_policy.policy_digest);
    expect(enabled[0].json.policy_digest).toBe(enabled[0].json.turn_policy.policy_digest);
    expect(disabled[0].json.policy_digest).not.toBe(enabled[0].json.policy_digest);
  });
});
