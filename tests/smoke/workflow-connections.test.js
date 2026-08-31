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
    'Dispatch Next Inbox Event', 'Upsert Early Opportunity', 'Follow-Up Lane Complete',
    // The v3 shadow evaluation is a fourth lane, dispatched after outbound
    // delivery and closed like the others.
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

    test(`${file} declares every Execute Workflow node in the link manifest`, () => {
      expect(missingWorkflowLinks(workflow)).toEqual([]);
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
  });

  describe('v3 post-provider delivery topology', () => {
    const workflow = readWorkflow('wa-inbound-downstream-dispatcher.json');

    test('records the v3 receipt only after the outbound subworkflow result is merged', () => {
      expect(branchTargets(workflow, 'Merge Outbound Context', 0)).toEqual(['V3 Delivery Result?']);
      expect(branchTargets(workflow, 'V3 Delivery Result?', 0)).toEqual(['Record V3 Delivery Receipt']);
      expect(branchTargets(workflow, 'V3 Delivery Result?', 1)).toEqual(['Outbound Lane Complete']);
      expect(branchTargets(workflow, 'Record V3 Delivery Receipt', 0)).toEqual(['Outbound Lane Complete']);
    });
  });
});
