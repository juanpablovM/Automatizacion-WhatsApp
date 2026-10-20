import fs from 'node:fs';
import { describe, expect, test } from 'vitest';

// tests/scripts/sync-workflow-nodes.mjs concatenates each fixture's declared
// `runtimes` ahead of its own source before writing the n8n Code node, so a
// fixture that depends on a shared runtime (like build-v3-lead-effect.js on
// shared/v3-line-items.js) never sees that runtime's functions unless this
// harness composes them the same way.
const runFixture = (name, row, runtimes = []) => {
  const source = fs.readFileSync(
    `tests/fixtures/workflow-nodes/wa-conversation-orchestrator/${name}.js`,
    'utf8',
  );
  const runtimeSources = runtimes.map((runtime) => fs.readFileSync(
    `tests/fixtures/workflow-nodes/${runtime}`,
    'utf8',
  ));
  const composed = [...runtimeSources, source].join('\n\n');
  return new Function('items', composed)([{ json: row }])[0].json;
};

const runEmbeddedNode = (name, row) => {
  const workflow = JSON.parse(fs.readFileSync('n8n/workflows/wa-conversation-orchestrator.json', 'utf8'));
  const node = workflow.nodes.find((candidate) => candidate.name === name);
  return new Function('items', node.parameters.jsCode)([{ json: row }])[0].json;
};

describe('v3 canonical effect executors', () => {
  test('maps a durable create_lead claim into the existing CRM workflow contract', () => {
    const output = runFixture('build-v3-lead-effect', {
      operation_key: 'lead-op-1',
      conversation_id: 42,
      source_number_id: 7,
      phone_number: '56900000000',
      qualification_context: {
        service: 'installation', city: 'Santiago', requirement: '25 square meters',
      },
    }, ['shared/v3-line-items.js']);

    expect(output).toMatchObject({
      operation_key: 'lead-op-1',
      conversation_id: 42,
      source_number_id: 7,
      phone_number: '56900000000',
      service: 'installation',
      city: 'Santiago',
      requirement: '25 square meters',
      commercial_missing_fields: [],
    });
  });

  test('normalizes create_lead success with lead_id', () => {
    const output = runFixture('normalize-v3-effect-receipt', {
      operation_key: 'lead-op-1',
      operation_type: 'create_lead',
      payload_digest: 'lead-payload-1',
      claim_token: 'claim-1',
      lead_id: 91,
    });

    expect(output.v3_effect_outcome).toBe('succeeded');
    expect(output.v3_effect_receipt).toMatchObject({
      version: 'v3_effect_receipt/v1', effect_type: 'create_lead', lead_id: 91,
    });
  });

  test('normalizes handoff success with handoff_id exclusively', () => {
    const output = runFixture('normalize-v3-effect-receipt', {
      operation_key: 'handoff-op-1',
      operation_type: 'handoff',
      payload_digest: 'handoff-payload-1',
      claim_token: 'claim-2',
      handoff_id: 92,
    });

    expect(output.v3_effect_receipt.handoff_id).toBe(92);
    expect(output.v3_effect_receipt).not.toHaveProperty('id');
    expect(output.v3_effect_external_id).toBe('92');
  });

  test('preserves the durable decision and selects the next unreceipted effect', () => {
    const first = {
      type: 'create_lead', operation_key: 'lead-op-1', payload_digest: 'lead-digest',
      payload: {}, required_before_reply: true,
    };
    const second = {
      type: 'handoff', operation_key: 'handoff-op-1', payload_digest: 'handoff-digest',
      payload: {}, required_before_reply: true,
    };
    const decision = { decision_id: 'decision-1', effect_commands: [first, second] };
    const output = runEmbeddedNode('Prepare V3 Effects', {
      v3_decision: decision,
      effect_receipt_refs: [{ operation_key: first.operation_key, status: 'succeeded', lead_id: 91 }],
    });

    expect(output.v3_decision).toEqual(decision);
    expect(output.v3_effect_command).toEqual(second);
    expect(output.v3_has_pending_effect).toBe(true);
  });
});
