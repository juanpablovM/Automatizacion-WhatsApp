// =============================================================================
// Smoke Test — Workflow connection graph
// -----------------------------------------------------------------------------
// check:parity validates the code and SQL *inside* nodes against their fixtures.
// Nothing validated the wiring between them, and that gap is not theoretical:
// the v3 conversational contract passed 13/13 tasks and 9/9 scenarios while its
// lane was never connected to the conversational output. Its branch terminated
// at `Prepare V3 Saga Result`, a 70-character passthrough with no outgoing
// connection, while the whole delivery chain hung off the legacy branch. Every
// fixture was correct; the graph was not.
//
// These rules are derived from the shape the 15 versioned workflows actually
// have today, not from taste, and both of them fire on that v3 orchestrator.
// =============================================================================

import { describe, test, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const workflowsDir = path.join(repoRoot, 'n8n', 'workflows');
const workflowLinks = JSON.parse(
  fs.readFileSync(path.join(repoRoot, 'n8n', 'workflow-links.json'), 'utf8'),
).links;

// The shadow evaluator retains one separately tracked pending credential/bind
// migration. No other versioned workflow may ship a placeholder credential or
// a legacy Postgres v1 bind shape.
const RUNTIME_NODE_ISSUE_ALLOWLIST = new Set([
  'ai-prd-shadow-evaluator.json::Persist Shadow Advisor Audit',
]);

// A sub-workflow returns the output of the last node that ran, so two terminals
// mean two different output contracts for the caller. One terminal is the norm:
// 11 of the 15 versioned workflows have exactly one. The exceptions are real and
// each is listed with the reason it is allowed, so adding a terminal is a
// deliberate edit here rather than a silent drift.
const ALLOWED_TERMINALS = {
  'ops-handoff-clickup-closure.json': [
    // Webhook responder: one reply node per authorization outcome.
    'Respond Applied', 'Respond Ignored', 'Respond Unauthorized',
  ],
  'wa-inbound-downstream-dispatcher.json': [
    // Genuinely parallel lanes, each ending in its own completion node.
    // `Follow-Up Lane Complete` used to be one of them and no longer is: it
    // writes `downstream_payload`, which `Mark Inbox Processed` requires to be
    // non-empty, so the completion gate has to wait for it.
    'Dispatch Next Inbox Event', 'Upsert Early Opportunity',
    // The v3 shadow evaluation is a lane, dispatched after outbound delivery
    // and closed like the others.
    'Shadow Lane Complete',
  ],
  'wa-inbound-entry.json': [
    // The health-check GET replies and stops; the POST hands off downstream.
    'Respond Health Check', 'Execute Durable Downstream Dispatcher',
  ],
};

const readWorkflow = (file) =>
  JSON.parse(fs.readFileSync(path.join(workflowsDir, file), 'utf8'));

const forwardEdges = (workflow) => {
  const edges = new Map();
  for (const [source, outputs] of Object.entries(workflow.connections || {})) {
    const branches = outputs.main || [];
    branches.forEach((branch, index) => {
      for (const target of branch || []) {
        if (!edges.has(source)) edges.set(source, []);
        edges.get(source).push({ index, target: target.node });
      }
    });
  }
  return edges;
};

export const terminalNodes = (workflow) => {
  const edges = forwardEdges(workflow);
  return workflow.nodes
    .map((node) => node.name)
    .filter((name) => !edges.has(name))
    .sort();
};

export const danglingBranches = (workflow) => {
  const edges = forwardEdges(workflow);
  return workflow.nodes
    .filter((node) => node.type === 'n8n-nodes-base.if')
    .map((node) => ({
      node: node.name,
      wired: [...new Set((edges.get(node.name) || []).map((edge) => edge.index))].sort(),
    }))
    .filter(({ wired }) => wired.length !== 2)
    .map(({ node, wired }) => `${node} wires outputs [${wired.join(', ')}]`);
};

// A Merge node in `combine` mode emits nothing unless every wired input carries
// items in the same run, and inside a loop that is silent. The v3 repair cycle
// re-entered `Execute AI Lead Qualification`, which feeds input 1 only, so
// `Merge AI Assistance` produced zero items on its second run: the branch died,
// the turn stayed `processing/orchestrating` forever, and n8n still reported the
// execution as a success with no error on any node.
//
// The rule: whenever a branch loops back into the feeders of a combine Merge, it
// must refill every wired input of that Merge, not a subset.
const inputEdges = (workflow) => {
  const edges = [];
  for (const [source, outputs] of Object.entries(workflow.connections || {})) {
    (outputs.main || []).forEach((branch, output) => {
      for (const target of branch || []) {
        edges.push({
          source, output, target: target.node, input: target.index || 0,
        });
      }
    });
  }
  return edges;
};

const walk = (edges, start, stopAt, visit) => {
  const seen = new Set();
  const queue = [start];
  while (queue.length) {
    const node = queue.shift();
    if (seen.has(node)) continue;
    seen.add(node);
    if (node === stopAt) continue;
    for (const edge of edges) {
      if (edge.source !== node) continue;
      visit(edge);
      queue.push(edge.target);
    }
  }
  return seen;
};

// Inside a cycle every edge trivially "reaches back" to its own source, so
// reachability alone would flag the whole loop. The edge that actually closes
// the loop is the DFS back edge: the one landing on a node still on the stack.
const backEdges = (workflow, edges) => {
  const targets = new Set(edges.map((edge) => edge.target));
  const roots = (workflow.nodes || [])
    .map((node) => node.name)
    .filter((name) => !targets.has(name));
  const found = [];
  const done = new Set();
  const stack = new Set();

  const visit = (node) => {
    stack.add(node);
    for (const edge of edges.filter((candidate) => candidate.source === node)) {
      if (stack.has(edge.target)) found.push(edge);
      else if (!done.has(edge.target)) visit(edge.target);
    }
    stack.delete(node);
    done.add(node);
  };

  const starts = roots.length ? roots : (workflow.nodes || []).map((node) => node.name);
  for (const start of starts) if (!done.has(start)) visit(start);
  for (const node of (workflow.nodes || []).map((n) => n.name)) if (!done.has(node)) visit(node);
  return found;
};

// Which inputs of `merge` this one output branch of `source` ends up feeding.
const branchFeedsInputs = (edges, source, output, merge) => {
  const inputs = new Set();
  for (const edge of edges) {
    if (edge.source !== source || edge.output !== output) continue;
    if (edge.target === merge) { inputs.add(edge.input); continue; }
    walk(edges, edge.target, merge, (downstream) => {
      if (downstream.target === merge) inputs.add(downstream.input);
    });
  }
  return inputs;
};

export const starvedMergeReentries = (workflow) => {
  const edges = inputEdges(workflow);
  const issues = [];
  const merges = (workflow.nodes || []).filter((node) => (
    node.type === 'n8n-nodes-base.merge' && node.parameters?.mode === 'combine'
  ));

  // A branch is a re-entry when it loops back: its target can reach its source.
  const reentries = [];
  for (const edge of backEdges(workflow, edges)) {
    const seen = reentries.some((r) => r.source === edge.source && r.output === edge.output);
    if (!seen) reentries.push({ source: edge.source, output: edge.output });
  }

  for (const merge of merges) {
    const wired = [...new Set(
      edges.filter((edge) => edge.target === merge.name).map((edge) => edge.input),
    )].sort();
    if (wired.length < 2) continue;

    for (const { source, output } of reentries) {
      const fed = branchFeedsInputs(edges, source, output, merge.name);
      if (fed.size === 0) continue; // this loop never reaches the merge
      const starved = wired.filter((input) => !fed.has(input));
      if (!starved.length) continue;
      issues.push(
        `${merge.name} starves input(s) [${starved.join(', ')}] `
        + `when ${source} [output ${output}] re-enters`,
      );
    }
  }
  return issues.sort();
};

export const unknownTargets = (workflow) => {
  const declared = new Set(workflow.nodes.map((node) => node.name));
  const edges = forwardEdges(workflow);
  const missing = new Set();
  for (const [source, outgoing] of edges) {
    if (!declared.has(source)) missing.add(source);
    for (const { target } of outgoing) if (!declared.has(target)) missing.add(target);
  }
  return [...missing].sort();
};

export const missingWorkflowLinks = (workflow, links = workflowLinks) => workflow.nodes
  .filter((node) => node.type === 'n8n-nodes-base.executeWorkflow')
  .filter((node) => !links.some((link) => (
    link.sourceWorkflow === workflow.name && link.node === node.name
  )))
  .map((node) => `${workflow.name} -> ${node.name}`)
  .sort();

const isPlaceholderCredential = (credential) => [credential?.id, credential?.name]
  .some((value) => /^__.*__$/.test(String(value || '')) || String(value || '').includes('__PENDIENTE__'));

export const placeholderCredentialIssues = (workflow, file, allowlist = RUNTIME_NODE_ISSUE_ALLOWLIST) => (
  workflow.nodes.flatMap((node) => {
    const nodeKey = `${file}::${node.name}`;
    if (allowlist.has(nodeKey)) return [];
    return Object.entries(node.credentials || {})
      .filter(([, credential]) => isPlaceholderCredential(credential))
      .map(([credentialType]) => `${nodeKey}::${credentialType}`);
  }).sort()
);

export const postgresV2BindingIssues = (workflow, file, allowlist = RUNTIME_NODE_ISSUE_ALLOWLIST) => (
  workflow.nodes
    .filter((node) => node.type === 'n8n-nodes-base.postgres' && Number(node.typeVersion) >= 2)
    .filter((node) => !allowlist.has(`${file}::${node.name}`))
    .filter((node) => !String(node.parameters?.options?.queryReplacement || '').trim())
    .map((node) => `${file}::${node.name}`)
    .sort()
);

// n8n's Postgres v1 node resolves every bound parameter with a flat lookup —
// `newItem[property] = item.json[property]` in its own genericFunctions.js — so
// a dotted path like `v3_recovery.decision.decision_id` binds undefined, which
// reaches Postgres as NULL. Nothing errors: the statement simply matches no row
// and returns an empty result. That is how `Commit V3 Contingency` silently
// committed nothing while every value it needed was present in the item.
export const nestedQueryParamIssues = (workflow, file, allowlist = RUNTIME_NODE_ISSUE_ALLOWLIST) => (
  (workflow.nodes || [])
    .filter((node) => node.type === 'n8n-nodes-base.postgres')
    .filter((node) => !allowlist.has(`${file}::${node.name}`))
    .flatMap((node) => String(node.parameters?.additionalFields?.queryParams || '')
      .split(',')
      .map((param) => param.trim())
      .filter((param) => param.includes('.'))
      .map((param) => `${file}::${node.name}::${param}`))
    .sort()
);

// `Mark Outbound Sending` projects `raw_payload AS outbound_body` and
// `raw_payload->>'number' AS phone_number`: for an outgoing message that column
// *is* the provider request body. A v3 commit that fills it with decision
// provenance instead ships a POST with no `text`, and the provider answers 200
// to a message that says nothing.
export const outboxBodyIssues = (workflow, file) => (
  (workflow.nodes || [])
    .filter((node) => node.type === 'n8n-nodes-base.postgres')
    .filter((node) => {
      const query = String(node.parameters?.query || '');
      return /INSERT INTO messages/i.test(query) && /'outgoing'/.test(query);
    })
    .flatMap((node) => {
      const query = String(node.parameters?.query || '');
      return [
        ["'number'", /'number',\s*target\.phone_number/],
        ["'text'", /'text',\s*target\.output_payload#>>'\{reply,text\}'/],
      ]
        .filter(([, pattern]) => !pattern.test(query))
        .map(([key]) => `${file}::${node.name} omits ${key} from the outbound body`);
    })
    .sort()
);

const branchTargets = (workflow, source, branch) => (
  workflow.connections?.[source]?.main?.[branch] || []
).map((target) => target.node).sort();

describe('Smoke — Workflow connection graph', () => {
  const workflowFiles = fs.readdirSync(workflowsDir).filter((f) => f.endsWith('.json'));

  for (const file of workflowFiles) {
    const workflow = readWorkflow(file);

    test(`${file} ends where it is supposed to`, () => {
      const expected = (ALLOWED_TERMINALS[file] || []).slice().sort();
      const terminals = terminalNodes(workflow);

      if (expected.length) {
        expect(terminals).toEqual(expected);
      } else {
        // A second terminal here means a branch that never rejoins the output.
        expect(terminals).toHaveLength(1);
      }
    });

    test(`${file} wires both branches of every IF`, () => {
      // An IF with one branch wired silently drops every item taking the other
      // path. No versioned workflow has one today; keep it that way.
      expect(danglingBranches(workflow)).toEqual([]);
    });

    test(`${file} connects only nodes that exist`, () => {
      expect(unknownTargets(workflow)).toEqual([]);
    });

    test(`${file} refills every input of a combine Merge it loops back into`, () => {
      // A starved input makes the Merge emit zero items on its second run and
      // the branch vanishes without an error anywhere.
      expect(starvedMergeReentries(workflow)).toEqual([]);
    });

    test(`${file} declares every Execute Workflow node in the link manifest`, () => {
      expect(missingWorkflowLinks(workflow)).toEqual([]);
    });

    test(`${file} has no runtime placeholder credentials`, () => {
      expect(placeholderCredentialIssues(workflow, file)).toEqual([]);
    });

    test(`${file} uses the Postgres v2 binding schema`, () => {
      expect(postgresV2BindingIssues(workflow, file)).toEqual([]);
    });

    test(`${file} queues outgoing messages with a sendable provider body`, () => {
      expect(outboxBodyIssues(workflow, file)).toEqual([]);
    });

    test(`${file} binds every Postgres parameter as a flat field`, () => {
      // A nested path binds NULL and the statement quietly matches nothing.
      expect(nestedQueryParamIssues(workflow, file)).toEqual([]);
    });
  }

  // A gate that cannot fail is decoration. These rebuild the exact shape of the
  // unwired v3 orchestrator and assert the rules reject it.
  describe('the rules reject the defect they were written for', () => {
    const brokenWorkflow = {
      nodes: [
        { name: 'Workflow Input', type: 'n8n-nodes-base.executeWorkflowTrigger' },
        { name: 'Use V3 Contract?', type: 'n8n-nodes-base.if' },
        { name: 'Prepare Conversation Output', type: 'n8n-nodes-base.code' },
        { name: 'V3 Route Fixed?', type: 'n8n-nodes-base.if' },
        { name: 'Prepare V3 Saga Result', type: 'n8n-nodes-base.code' },
      ],
      connections: {
        'Workflow Input': { main: [[{ node: 'Use V3 Contract?' }]] },
        'Use V3 Contract?': {
          main: [
            [{ node: 'V3 Route Fixed?' }],
            [{ node: 'Prepare Conversation Output' }],
          ],
        },
        // Only the true branch is wired: items taking the false path vanish.
        'V3 Route Fixed?': { main: [[{ node: 'Prepare V3 Saga Result' }]] },
      },
    };

    test('a lane that never rejoins the output is caught as a second terminal', () => {
      expect(terminalNodes(brokenWorkflow)).toEqual([
        'Prepare Conversation Output',
        'Prepare V3 Saga Result',
      ]);
      expect(terminalNodes(brokenWorkflow)).not.toHaveLength(1);
    });

    test('an IF with one branch wired is caught', () => {
      expect(danglingBranches(brokenWorkflow)).toEqual(['V3 Route Fixed? wires outputs [0]']);
    });

    test('a connection to a node that does not exist is caught', () => {
      const withGhost = {
        ...brokenWorkflow,
        connections: {
          ...brokenWorkflow.connections,
          'Prepare V3 Saga Result': { main: [[{ node: 'Node That Was Deleted' }]] },
        },
      };
      expect(unknownTargets(withGhost)).toEqual(['Node That Was Deleted']);
    });

    test('an Execute Workflow node omitted from the manifest is caught', () => {
      const unlinked = {
        name: 'Synthetic Source',
        nodes: [{
          name: 'Portable Executor',
          type: 'n8n-nodes-base.executeWorkflow',
          parameters: { workflowId: { value: '' } },
        }],
      };
      expect(missingWorkflowLinks(unlinked, [])).toEqual([
        'Synthetic Source -> Portable Executor',
      ]);
    });

    test('a placeholder credential is caught', () => {
      const workflow = {
        nodes: [{
          name: 'Broken Postgres',
          credentials: { postgres: { id: '__PENDIENTE__', name: 'Postgres' } },
        }],
      };
      expect(placeholderCredentialIssues(workflow, 'synthetic.json', new Set())).toEqual([
        'synthetic.json::Broken Postgres::postgres',
      ]);
    });

    test('a Postgres parameter bound through a nested path is caught', () => {
      const workflow = {
        nodes: [{
          name: 'Commit V3 Contingency',
          type: 'n8n-nodes-base.postgres',
          typeVersion: 1,
          parameters: {
            additionalFields: {
              queryParams: 'decision_id, v3_recovery.decision.decision_id, processing_token',
            },
          },
        }],
      };
      expect(nestedQueryParamIssues(workflow, 'synthetic.json', new Set())).toEqual([
        'synthetic.json::Commit V3 Contingency::v3_recovery.decision.decision_id',
      ]);
    });

    test('a repair loop that refills only one input of a combine Merge is caught', () => {
      // The exact shape the canary died on: the loop re-enters the AI call,
      // which feeds input 1, while input 0 is fed only by the policy node that
      // never runs a second time.
      const starvedLoop = {
        nodes: [
          { name: 'Compile V3 Turn Policy', type: 'n8n-nodes-base.code' },
          { name: 'Execute AI Lead Qualification', type: 'n8n-nodes-base.executeWorkflow' },
          {
            name: 'Merge AI Assistance',
            type: 'n8n-nodes-base.merge',
            parameters: { mode: 'combine', combineBy: 'combineByPosition', numberInputs: 2 },
          },
          { name: 'Build V3 Repair', type: 'n8n-nodes-base.code' },
          { name: 'V3 Recovery Is Contingency?', type: 'n8n-nodes-base.if' },
          { name: 'Prepare V3 Contingency Decision', type: 'n8n-nodes-base.code' },
        ],
        connections: {
          'Compile V3 Turn Policy': {
            main: [[
              { node: 'Execute AI Lead Qualification', index: 0 },
              { node: 'Merge AI Assistance', index: 0 },
            ]],
          },
          'Execute AI Lead Qualification': { main: [[{ node: 'Merge AI Assistance', index: 1 }]] },
          'Merge AI Assistance': { main: [[{ node: 'Build V3 Repair', index: 0 }]] },
          'Build V3 Repair': { main: [[{ node: 'V3 Recovery Is Contingency?', index: 0 }]] },
          'V3 Recovery Is Contingency?': {
            main: [
              [{ node: 'Prepare V3 Contingency Decision', index: 0 }],
              [{ node: 'Execute AI Lead Qualification', index: 0 }],
            ],
          },
        },
      };

      expect(starvedMergeReentries(starvedLoop)).toEqual([
        'Merge AI Assistance starves input(s) [0] '
        + 'when V3 Recovery Is Contingency? [output 1] re-enters',
      ]);

      // Refilling input 0 on the same branch clears it.
      const refilled = {
        ...starvedLoop,
        connections: {
          ...starvedLoop.connections,
          'V3 Recovery Is Contingency?': {
            main: [
              [{ node: 'Prepare V3 Contingency Decision', index: 0 }],
              [
                { node: 'Execute AI Lead Qualification', index: 0 },
                { node: 'Merge AI Assistance', index: 0 },
              ],
            ],
          },
        },
      };
      expect(starvedMergeReentries(refilled)).toEqual([]);
    });

    test('a Postgres v2 node with legacy queryParams is caught', () => {
      const workflow = {
        nodes: [{
          name: 'Legacy Bind Shape',
          type: 'n8n-nodes-base.postgres',
          typeVersion: 2.6,
          parameters: { additionalFields: { queryParams: 'id' } },
        }],
      };
      expect(postgresV2BindingIssues(workflow, 'synthetic.json', new Set())).toEqual([
        'synthetic.json::Legacy Bind Shape',
      ]);
    });
  });

  describe('v3 durable authority topology', () => {
    const workflow = readWorkflow('wa-conversation-orchestrator.json');

    test('routes and fixes v3 before policy compilation, with explicit legacy degradation', () => {
      expect(branchTargets(workflow, 'Resolve Conversation Contract Route', 0)).toEqual(['Route V3 Early?']);
      expect(branchTargets(workflow, 'Route V3 Early?', 0)).toEqual([
        'Fix V3 Route',
        'Merge V3 Route Context',
      ]);
      expect(branchTargets(workflow, 'Route V3 Early?', 1)).toEqual(['Evaluate Conversation Step']);
      expect(branchTargets(workflow, 'V3 Route Fixed?', 0)).toEqual(['Evaluate Conversation Step']);
      expect(branchTargets(workflow, 'V3 Route Fixed?', 1)).toEqual(['Degrade V3 Route To Legacy']);
      expect(branchTargets(workflow, 'Degrade V3 Route To Legacy', 0)).toEqual(['Evaluate Conversation Step']);
    });

    test('carries the repaired policy back into the AI merge on the second cycle', () => {
      // Both feeders of `Merge AI Assistance` must fire again on repair: the
      // repaired policy into input 0 and the retried AI proposal into input 1.
      expect(branchTargets(workflow, 'V3 Recovery Is Contingency?', 1)).toEqual([
        'Execute AI Lead Qualification',
        'Merge AI Assistance',
      ]);
      expect(
        (workflow.connections['V3 Recovery Is Contingency?'].main[1] || [])
          .find(({ node }) => node === 'Merge AI Assistance').index,
      ).toBe(0);
    });

    test('restores the turn context before committing a contingency', () => {
      // A Postgres node replaces the item with its result set, so the row coming
      // out of `Prepare V3 Contingency Decision` carries neither `v3_recovery`
      // nor `processing_token` — the two parameters `Commit V3 Contingency`
      // binds. The valid lane already solves this by merging the workflow
      // context back over the row; the contingency lane must do the same or the
      // commit matches no execution and silently returns zero rows.
      expect(branchTargets(workflow, 'V3 Recovery Is Contingency?', 0)).toEqual([
        'Merge V3 Contingency Context',
        'Prepare V3 Contingency Decision',
      ]);
      expect(branchTargets(workflow, 'Prepare V3 Contingency Decision', 0))
        .toEqual(['Merge V3 Contingency Context']);
      expect(branchTargets(workflow, 'Merge V3 Contingency Context', 0))
        .toEqual(['Commit V3 Contingency']);

      // Context on input 0, database row on input 1 — the same shape the
      // authority lane uses, so the row wins on clashing fields.
      const inputOf = (source) => workflow.connections[source].main
        .flat()
        .find(({ node }) => node === 'Merge V3 Contingency Context').index;
      expect(inputOf('V3 Recovery Is Contingency?')).toBe(0);
      expect(inputOf('Prepare V3 Contingency Decision')).toBe(1);

      const merge = workflow.nodes.find(({ name }) => name === 'Merge V3 Contingency Context');
      const authority = workflow.nodes.find(({ name }) => name === 'Merge V3 Authority Context');
      expect(merge.type).toBe('n8n-nodes-base.merge');
      expect(merge.typeVersion).toBe(authority.typeVersion);
      expect(merge.parameters).toEqual(authority.parameters);
    });

    test('attaches a valid decision directly to the early ledger', () => {
      expect(branchTargets(workflow, 'V3 Proposal Valid?', 0)).toEqual([
        'Merge V3 Authority Context',
        'Persist V3 Turn Authority',
      ]);
      expect(branchTargets(workflow, 'V3 Proposal Valid?', 1)).toEqual(['Build V3 Repair']);
    });

    test('executes canonical v3 effects and converges both receipts before commit', () => {
      expect(branchTargets(workflow, 'Prepare V3 Effect', 0)).toEqual(['V3 Effect Should Execute?']);
      expect(branchTargets(workflow, 'V3 Effect Should Execute?', 0)).toEqual(['V3 Effect Is Create Lead?']);
      expect(branchTargets(workflow, 'V3 Effect Should Execute?', 1)).toEqual(['V3 Effect Needs Reconciliation?']);
      expect(branchTargets(workflow, 'V3 Effect Is Create Lead?', 0)).toEqual(['Build V3 Lead Effect']);
      expect(branchTargets(workflow, 'V3 Effect Is Create Lead?', 1)).toEqual(['Persist V3 Handoff Effect']);
      expect(branchTargets(workflow, 'Merge V3 Lead Effect Context', 0)).toEqual(['Normalize V3 Effect Receipt']);
      expect(branchTargets(workflow, 'Persist V3 Handoff Effect', 0)).toEqual(['Normalize V3 Effect Receipt']);
      expect(branchTargets(workflow, 'Normalize V3 Effect Receipt', 0)).toEqual(['Record V3 Effect Result']);
      expect(branchTargets(workflow, 'Record V3 Effect Result', 0)).toEqual(['Prepare V3 Effects']);
      const executor = workflow.nodes.find(({ name }) => name === 'Execute V3 Lead Effect');
      expect(executor.type).toBe('n8n-nodes-base.executeWorkflow');
      expect(executor.parameters.workflowId.cachedResultName).toBe('CRM - Lead Creation And Assignment');
      expect(executor.parameters.options.waitForSubWorkflow).toBe(true);
    });

    test('declares the portable v3 lead executor in the workflow link manifest', () => {
      expect(workflowLinks).toContainEqual({
        sourceWorkflow: 'WA - Conversation Orchestrator',
        node: 'Execute V3 Lead Effect',
        targetWorkflow: 'CRM - Lead Creation And Assignment',
      });
    });

    test('leaves delivery pending in the orchestrator until the provider returns', () => {
      expect(branchTargets(workflow, 'Commit V3 State And Outbox', 0)).toEqual(['Prepare V3 Saga Result']);
      expect(branchTargets(workflow, 'Commit V3 Contingency', 0)).toEqual(['Prepare V3 Saga Result']);
      expect(workflow.nodes.some(({ name }) => name === 'V3 Has Delivery Receipt?')).toBe(false);
      expect(workflow.nodes.some(({ name }) => name === 'Record V3 Delivery')).toBe(false);
    });

    test('uses the canonical Postgres credential and explicit v2 bind arrays', () => {
      const expectedCredential = {
        id: '4f0b597f-5081-48fc-9226-1cd8db06ca38',
        name: 'Postgres CRM App Local',
      };
      const expectedBindings = {
        'Fix V3 Route': '={{ [$json.inbound_event_id, $json.processing_token, $json.conversation_id, $json.input_source_number_id, $json.phone_number, $json.contract_mode, $json.route_rule_id, $json.current_step, $json.message_type, $json.input_external_message_id, $json.input_external_timestamp, $json.text_body, $json.raw_payload_json] }}',
        // This node runs after `Merge AI Assistance`, which combines with
        // `addSuffix`: ten of these eighteen fields exist only as `_1` by the
        // time it binds them. Bound bare they arrived NULL, the statement matched
        // no execution, and `Merge V3 Authority Context` starved on the empty
        // result — the whole authorized turn vanished with nothing reported.
        'Persist V3 Turn Authority': "={{ [$json.inbound_event_id ?? $json.inbound_event_id_1, $json.processing_token ?? $json.processing_token_1, $json.conversation_id ?? $json.conversation_id_1, $json.source_number_id ?? $json.source_number_id_1, $json.phone_number ?? $json.phone_number_1, $json.message_type ?? $json.message_type_1, $json.external_message_id ?? $json.external_message_id_1, $json.text_body ?? $json.text_body_1, $json.raw_payload_json ?? $json.raw_payload_json_1, $json.current_step ?? $json.current_step_1, $json.decision_id ?? $json.decision_id_1, $json.turn_policy ?? $json.turn_policy_1, $json.ai_proposal ?? $json.ai_proposal_1, $json.v3_validation ?? $json.v3_validation_1, $json.v3_decision ?? $json.v3_decision_1, $json.ai_provider ?? $json.ai_provider_1, $json.ai_model ?? $json.ai_model_1, $json.decision_digest ?? $json.decision_digest_1] }}",
      };

      for (const [name, queryReplacement] of Object.entries(expectedBindings)) {
        const node = workflow.nodes.find((candidate) => candidate.name === name);
        expect(node.typeVersion).toBe(2.6);
        expect(node.credentials.postgres).toEqual(expectedCredential);
        expect(node.parameters.options).toEqual({
          queryBatching: 'transaction',
          queryReplacement,
        });
        expect(node.parameters.additionalFields).toBeUndefined();
      }
    });
  });

  describe('inbound completion gate', () => {
    const workflow = readWorkflow('wa-inbound-downstream-dispatcher.json');

    test('waits for the lane that writes downstream_payload before closing the inbox', () => {
      // `Mark Inbox Processed` refuses to close an event whose
      // `downstream_payload` is still `{}`, and `Apply Inbound Follow-Up Policy`
      // is the only node that writes it. That lane used to run in parallel with
      // the completion gate, so whether the inbound event closed came down to
      // which one won the race — the canary lost it, leaving a delivered turn
      // stuck in `processing/orchestrating` with nothing reported as failed.
      const writers = workflow.nodes.filter(
        (node) => /downstream_payload\s*=/.test(String(node.parameters?.query || '')),
      );
      expect(writers.map(({ name }) => name)).toEqual(['Apply Inbound Follow-Up Policy']);

      expect(branchTargets(workflow, 'Apply Inbound Follow-Up Policy', 0))
        .toEqual(['Follow-Up Lane Complete']);
      expect(branchTargets(workflow, 'Follow-Up Lane Complete', 0))
        .toEqual(['Merge Dispatch Completion']);
      expect(branchTargets(workflow, 'Merge Dispatch Completion', 0))
        .toEqual(['Mark Inbox Processed']);
    });

    test('declares one merge input per lane it waits for', () => {
      // combineByPosition emits nothing unless every input carries an item, so
      // the declared count and the wired inputs have to agree exactly.
      const merge = workflow.nodes.find(({ name }) => name === 'Merge Dispatch Completion');
      const wired = new Set();
      for (const [, connection] of Object.entries(workflow.connections)) {
        for (const branch of connection.main || []) {
          for (const target of branch || []) {
            if (target.node === 'Merge Dispatch Completion') wired.add(target.index || 0);
          }
        }
      }
      expect(merge.parameters.numberInputs).toBe(4);
      expect([...wired].sort()).toEqual([0, 1, 2, 3]);
    });
  });

  describe('v3 post-provider delivery topology', () => {
    const workflow = readWorkflow('wa-inbound-downstream-dispatcher.json');

    test('records the v3 receipt only after the outbound subworkflow result is merged', () => {
      expect(branchTargets(workflow, 'Merge Outbound Context', 0)).toEqual(['V3 Delivery Result?']);
      expect(branchTargets(workflow, 'V3 Delivery Result?', 0)).toEqual(['Record V3 Delivery Receipt']);
      expect(branchTargets(workflow, 'V3 Delivery Result?', 1)).toEqual(['Outbound Lane Complete']);
      expect(branchTargets(workflow, 'Record V3 Delivery Receipt', 0)).toEqual(['Outbound Lane Complete']);
    });

    test('binds the exact delivery receipt fields with the Postgres v2 schema', () => {
      const node = workflow.nodes.find(({ name }) => name === 'Record V3 Delivery Receipt');
      expect(node.parameters.options).toEqual({
        queryBatching: 'transaction',
        queryReplacement: '={{ [$json.decision_id, $json.delivery_message_id, $json.delivery_status, $json.provider_external_message_id, $json.delivery_key] }}',
      });
      expect(node.parameters.additionalFields).toBeUndefined();
    });
  });
});
