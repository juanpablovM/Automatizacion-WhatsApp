// =============================================================================
// Conversation engine driver.
// -----------------------------------------------------------------------------
// Runs the two Code nodes that decide a turn, taken from the workflow JSON so a
// scenario binds the artifact that gets deployed, not a copy of it.
//
// `Apply AI Assistance` sits behind an n8n merge node configured with
// `resolveClash: addSuffix`, which suffixes the deterministic branch with `_1`.
// `mergeAiShape` reproduces exactly that, and the suffix is load-bearing:
// `service`, `city`, `requirement` and `should_create_lead` are read bare from
// the model proposal and suffixed from the deterministic branch, so the two
// values of the same name must not be collapsed.
// =============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const workflowPath = path.join(repoRoot, 'n8n', 'workflows', 'wa-conversation-orchestrator.json');

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

const workflow = JSON.parse(fs.readFileSync(workflowPath, 'utf8'));

const codeOf = (nodeName) => {
  const node = workflow.nodes.find((candidate) => candidate.name === nodeName);
  if (!node) throw new Error(`Workflow node not found: ${nodeName}`);
  const code = node.parameters?.jsCode;
  if (typeof code !== 'string') throw new Error(`Node carries no jsCode: ${nodeName}`);
  return code;
};

const evaluateCode = codeOf('Evaluate Conversation Step');
const applyCode = codeOf('Apply AI Assistance');

export const runEvaluate = async (row) => {
  const fn = new AsyncFunction('items', evaluateCode);
  const normalized = {
    has_existing_conversation: Boolean(
      row.has_existing_conversation ?? row.has_active_conversation ?? row.conversation_id,
    ),
    ...row,
  };
  const result = await fn([{ json: normalized }]);
  return result[0].json;
};

export const runApplyAi = async (row, env = {}) => {
  const fn = new AsyncFunction('items', '$env', applyCode);
  const result = await fn([{ json: row }], env);
  return result[0].json;
};

export const mergeAiShape = (deterministicRow, aiRow) => ({
  ...aiRow,
  ...Object.fromEntries(Object.entries(deterministicRow).map(([key, value]) => [`${key}_1`, value])),
});

// One turn: the deterministic step decides, then the model proposal is applied
// over it. A turn with no proposal still runs the apply node, because that node
// owns the fallback copy and the persisted payloads.
export const runTurn = async (inputRow, aiProposal, env = {}) => {
  const deterministic = await runEvaluate(inputRow);
  const proposal = aiProposal ?? { ai_skipped: true, ai_skip_reason: 'scenario_without_proposal' };
  const applied = await runApplyAi(mergeAiShape(deterministic, proposal), env);
  return { deterministic, applied };
};
