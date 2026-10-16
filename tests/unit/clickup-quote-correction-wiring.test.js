// =============================================================================
// Quote correction (owner decision 2026-10-14): wiring the workflows need for a
// customer's correction to reach the same lead and ClickUp task. The SQL and
// Code nodes carry their own tests; these pin the n8n parameters between them.
// =============================================================================
import fs from 'node:fs';
import { describe, expect, test } from 'vitest';

const workflow = (name) => JSON.parse(fs.readFileSync(`n8n/workflows/${name}.json`, 'utf8'));
const node = (workflowName, nodeName) => workflow(workflowName).nodes.find((entry) => entry.name === nodeName);

describe('quote correction wiring', () => {
  test('the acquisition records the task status the transition ended in', () => {
    const acquire = node('ops-handoff-clickup-closure', 'Acquire Lead Chat Ownership');
    expect(acquire.parameters.options.queryReplacement).toContain(
      "$('Normalize ClickUp Closure').first().json.clickup_history_at, $('Normalize ClickUp Closure').first().json.clickup_new_status,",
    );
  });

  test('the acquisition receives the configurable quote-sent statuses as its sixth parameter', () => {
    const acquire = node('ops-handoff-clickup-closure', 'Acquire Lead Chat Ownership');
    expect(acquire.parameters.options.queryReplacement).toContain(
      "clickup_new_status, $env.CLICKUP_STATUS_QUOTE_SENT_FOLLOWUP || 'cotización enviada,seguimiento'] }}",
    );
  });

  test('the v3 route receives the reopened-quote flag as its last parameter', () => {
    const route = node('wa-conversation-orchestrator', 'Fix V3 Route');
    expect(route.parameters.options.queryReplacement).toContain(
      '$json.raw_payload_json, $json.reopen_confirmed_quote === true] }}',
    );
  });
});
