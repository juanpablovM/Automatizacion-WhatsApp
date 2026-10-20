import fs from 'node:fs';
import { describe, expect, test } from 'vitest';

// Live regression 2026-10-02 (after task 3c.25): when a customer writes again
// after a handoff, the escalation upsert reuses the already-notified open
// handoff. The handoff notification sub-workflow then has nothing to notify and
// returns zero items, so "Escalation Lane Complete" never ran, "Merge Dispatch
// Completion" never completed and the inbound event stayed in "processing".
// The dispatch node must emit an item even when the sub-workflow returns none.
const WORKFLOW = 'n8n/workflows/wa-inbound-downstream-dispatcher.json';

describe('dispatcher escalation lane always completes', () => {
  const workflow = JSON.parse(fs.readFileSync(WORKFLOW, 'utf8'));
  const node = workflow.nodes.find((entry) => entry.name === 'Dispatch Handoff Notification Workflow');

  test('the handoff notification dispatch still feeds the escalation lane completion', () => {
    expect(workflow.connections['Dispatch Handoff Notification Workflow'].main[0].map((link) => link.node))
      .toEqual(['Escalation Lane Complete']);
  });

  test('the handoff notification dispatch outputs an item when the sub-workflow returns none', () => {
    expect(node.alwaysOutputData).toBe(true);
  });

  test('the escalation lane completion tolerates an empty sub-workflow result', () => {
    const completion = workflow.nodes.find((entry) => entry.name === 'Escalation Lane Complete');
    expect(completion.parameters.jsCode).toContain('items[0]?.json ?? {}');
  });
});
