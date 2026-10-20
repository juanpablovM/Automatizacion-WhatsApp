// =============================================================================
// Inbound debounce wiring. The claim SQL defers a customer's turn until the
// contact's queue has been quiet for the window; something must wake the queue
// once the window closes or a lone message waits for the minute scheduler. The
// entry webhook does it: after answering Evolution it waits the window and runs
// the recovery claim scoped to that contact's queue.
// =============================================================================
import fs from 'node:fs';
import { describe, expect, test } from 'vitest';

const workflow = (name) => JSON.parse(fs.readFileSync(`n8n/workflows/${name}.json`, 'utf8'));
const node = (wf, name) => wf.nodes.find((candidate) => candidate.name === name);
const targets = (wf, name, output = 0) => (wf.connections[name]?.main?.[output] || []).map((edge) => edge.node);

describe('WA - Inbound Entry debounce waiter', () => {
  const entry = workflow('wa-inbound-entry');

  test('the durable inbox claim receives the effective window', () => {
    const replacement = node(entry, 'Persist Durable Inbox').parameters.options.queryReplacement;
    expect(replacement).toContain('$json.inbound_debounce_seconds');
    const sql = fs.readFileSync('db/queries/n8n/inbound-events/01_claim_inbound_event.sql', 'utf8');
    expect(sql).toContain("'debounce_seconds'");
    expect(sql).toContain('$22');
  });

  test('answers Evolution first, then waits the window and drains its own queue', () => {
    expect(targets(entry, 'Respond Accepted')).toEqual(['Filter Processable Events', 'Select Debounced Inbox Events']);
    expect(node(entry, 'Select Debounced Inbox Events').type).toBe('n8n-nodes-base.code');
    expect(targets(entry, 'Select Debounced Inbox Events')).toEqual(['Wait Debounce Window']);

    const wait = node(entry, 'Wait Debounce Window');
    expect(wait.type).toBe('n8n-nodes-base.wait');
    expect(wait.parameters).toMatchObject({
      resume: 'timeInterval',
      amount: '={{ $json.debounce_wait_seconds }}',
      unit: 'seconds',
    });
    expect(targets(entry, 'Wait Debounce Window')).toEqual(['Drain Debounced Inbox']);

    const drain = node(entry, 'Drain Debounced Inbox');
    expect(drain.type).toBe('n8n-nodes-base.executeWorkflow');
    expect(drain.parameters.workflowId.cachedResultName).toBe('WA - Inbound Recovery');
    expect(drain.parameters.mode).toBe('each');
    expect(drain.parameters.options).toEqual({ waitForSubWorkflow: false });
  });

  test('the drain is linked to the recovery workflow at import time', () => {
    const manifest = JSON.parse(fs.readFileSync('n8n/workflow-links.json', 'utf8'));
    expect(manifest.links).toContainEqual({
      sourceWorkflow: 'WA - Inbound Entry',
      node: 'Drain Debounced Inbox',
      targetWorkflow: 'WA - Inbound Recovery',
    });
  });
});

describe('WA - Inbound Recovery debounce-aware claim', () => {
  const recovery = workflow('wa-inbound-recovery');

  test('passes the window, the max wait and the optional queue scope to the claim', () => {
    const claim = node(recovery, 'Recover And Claim FIFO Events');
    expect(claim.parameters.query).toBe(
      fs.readFileSync('db/queries/n8n/inbound-events/02_recover_and_claim_inbound_events.sql', 'utf8'),
    );
    expect(claim.parameters.options.queryReplacement).toBe(
      '={{ [$json.stale_seconds, $json.batch_size, $json.max_attempts, $json.debounce_seconds, $json.debounce_max_wait_seconds, $json.queue_scope_inbound_event_id] }}',
    );
  });
});

describe('runtime configuration', () => {
  test('production n8n receives the debounce env with the owner default', () => {
    const compose = fs.readFileSync('docker-compose.yml', 'utf8');
    expect(compose).toContain('INBOUND_DEBOUNCE_SECONDS: ${INBOUND_DEBOUNCE_SECONDS:-6}');
    expect(compose).toContain('INBOUND_DEBOUNCE_MAX_WAIT_SECONDS: ${INBOUND_DEBOUNCE_MAX_WAIT_SECONDS:-30}');
  });

  test('the isolated n8n test stack keeps one turn per message unless a test asks', () => {
    const compose = fs.readFileSync('docker-compose.test.yml', 'utf8');
    expect(compose).toContain('INBOUND_DEBOUNCE_SECONDS: ${TEST_INBOUND_DEBOUNCE_SECONDS:-0}');
  });
});
