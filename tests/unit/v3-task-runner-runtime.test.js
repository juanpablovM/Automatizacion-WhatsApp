import fs from 'node:fs';
import { describe, expect, test } from 'vitest';

const executeBundledNode = (workflowName, nodeName, input, env = {}) => {
  const workflow = JSON.parse(fs.readFileSync(`n8n/workflows/${workflowName}.json`, 'utf8'));
  const node = workflow.nodes.find(({ name }) => name === nodeName);
  const forbiddenRequire = (name) => { throw new Error(`Module '${name}' is disallowed`); };
  return new Function('items', '$env', 'module', 'exports', 'require', node.parameters.jsCode)(
    [{ json: input }], env, { exports: {} }, {}, forbiddenRequire,
  )[0].json;
};

const turn = { inbound_event_id: 901, conversation_id: 44, phone_number: '15550009001',
  text_body: 'Hola', qualification_context: {}, pending_question_key: null };

describe('v3 bundled task-runner runtime', () => {
  test('defaults to enforce without loading a relative module', () => {
    const route = executeBundledNode('wa-conversation-orchestrator', 'Resolve Conversation Contract Route', turn);
    expect(route).toMatchObject({ contract_version: 'v3', contract_mode: 'enforce' });
  });

  test('compiles the first real v3 turn under task-runner module restrictions', () => {
    const result = executeBundledNode('wa-conversation-orchestrator', 'Compile V3 Turn Policy', {
      ...turn, contract_version: 'v3', v3_grounding: { catalog: [] },
    });
    expect(result.v3_policy).toMatchObject({ version: 'ai_prd_turn_policy/v3', turn: { id: '901', conversation_id: '44' } });
    expect(result.policy_digest).toMatch(/^[a-f0-9]{64}$/);
  });

  test('preserves persisted final-confirmation authority in the bundled compiler', () => {
    const result = executeBundledNode('wa-conversation-orchestrator', 'Compile V3 Turn Policy', {
      ...turn, contract_version: 'v3', pending_question_key: 'final_confirmation',
    });
    expect(result.v3_policy.turn.pending_question_goal_id).toBe('final_confirmation');
  });
});
