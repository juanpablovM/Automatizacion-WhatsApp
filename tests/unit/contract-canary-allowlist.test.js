// Going from "shadow says the model reads the customer" to "the model answers
// the customer" is a large step: shadow never delivers, so the v3 delivery path
// — authority, effects, commit, outbound — has only ever run against a mock
// whose proposal was hand-written. An allowlist makes that step small: named
// numbers get the v3 lane for real, everyone else stays on legacy.
//
// `Resolve Conversation Contract Route` already prefers `requested_contract_mode`
// over the global `$env.AI_PRD_CONTRACT_MODE`, and `Load Conversation State`
// hands it `phone_number`. Nothing set the override; this does.
import fs from 'node:fs';
import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
import { describe, expect, test } from 'vitest';

const workflowPath = 'n8n/workflows/wa-conversation-orchestrator.json';
const routeFor = (row, env) => {
  const workflow = JSON.parse(fs.readFileSync(workflowPath, 'utf8'));
  const node = workflow.nodes.find(({ name }) => name === 'Resolve Conversation Contract Route');
  return new Function(
    'items', '$env', 'module', 'exports', 'require', node.parameters.jsCode,
  )([{ json: row }], env, { exports: {} }, {}, nodeRequire)[0].json;
};

const turn = (phone) => ({ inbound_event_id: 501, conversation_id: 9, phone_number: phone });

describe('a named number can be served by v3 while everyone else stays on legacy', () => {
  test('routes an allowlisted number to the v3 lane', () => {
    const out = routeFor(turn('56997093038'), {
      AI_PRD_CONTRACT_MODE: 'legacy',
      AI_PRD_CONTRACT_CANARY_PHONES: '56997093038',
    });

    expect(out.contract_version).toBe('v3');
    expect(out.contract_mode).toBe('canary');
  });

  test('leaves every other number exactly where the global switch puts it', () => {
    // The blast radius of the allowlist is the allowlist. A number that is not
    // on it must be unaffected by its existence.
    const out = routeFor(turn('56911112222'), {
      AI_PRD_CONTRACT_MODE: 'legacy',
      AI_PRD_CONTRACT_CANARY_PHONES: '56997093038',
    });

    expect(out.contract_version).toBe('legacy');
    expect(out.contract_mode).toBe('legacy');
  });

  test('matches on digits, so formatting never decides the lane', () => {
    const out = routeFor(turn('+56 9 9709 3038'), {
      AI_PRD_CONTRACT_MODE: 'legacy',
      AI_PRD_CONTRACT_CANARY_PHONES: '56997093038, 56911112222',
    });

    expect(out.contract_mode).toBe('canary');
  });

  test('an empty or unset allowlist changes nothing', () => {
    for (const value of [undefined, '', '   ', ',,']) {
      const out = routeFor(turn('56997093038'), {
        AI_PRD_CONTRACT_MODE: 'legacy',
        ...(value === undefined ? {} : { AI_PRD_CONTRACT_CANARY_PHONES: value }),
      });

      expect(out.contract_mode, `allowlist ${JSON.stringify(value)} leaked`).toBe('legacy');
    }
  });

  test('never downgrades a turn the global switch already routes to v3', () => {
    // With the global switch on enforce, an unlisted number must not be pulled
    // back to legacy by the allowlist's absence.
    const out = routeFor(turn('56911112222'), {
      AI_PRD_CONTRACT_MODE: 'enforce',
      AI_PRD_CONTRACT_CANARY_PHONES: '56997093038',
    });

    expect(out.contract_mode).toBe('enforce');
    expect(out.contract_version).toBe('v3');
  });

  test('an explicit per-turn request still wins, so replay stays deterministic', () => {
    const out = routeFor(
      { ...turn('56997093038'), requested_contract_mode: 'legacy' },
      { AI_PRD_CONTRACT_MODE: 'legacy', AI_PRD_CONTRACT_CANARY_PHONES: '56997093038' },
    );

    expect(out.contract_mode).toBe('legacy');
  });
});
