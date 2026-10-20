import fs from 'node:fs';
import { describe, expect, test } from 'vitest';

// Migration 037: the quote follow-up alert lane of OPS - Lead Chat Lease
// Scheduler. Claim -> notice text -> WA - Outbound Messages -> ClickUp comment
// -> completion by claim token.

const workflow = JSON.parse(fs.readFileSync('n8n/workflows/ops-lead-chat-lease-scheduler.json', 'utf8'));
const node = (name) => workflow.nodes.find((entry) => entry.name === name);
const next = (name) => (workflow.connections[name]?.main?.[0] || []).map((entry) => entry.node);
const fixture = (file) => fs.readFileSync(`tests/fixtures/workflow-nodes/ops-lead-chat-lease-scheduler/${file}`, 'utf8');
const sql = (file) => fs.readFileSync(`db/queries/n8n/lead-chat-ownership/${file}`, 'utf8');

describe('quote follow-up alert lane wiring', () => {
  test('both triggers start the claim', () => {
    expect(next('Lead Chat Lease Schedule')).toContain('Claim Quote Follow-Up Alerts');
    expect(next('Workflow Input')).toContain('Claim Quote Follow-Up Alerts');
  });

  test('the claim runs 11 with the configurable SLA, re-alert window and stale window', () => {
    const claim = node('Claim Quote Follow-Up Alerts');
    expect(claim.type).toBe('n8n-nodes-base.postgres');
    expect(claim.parameters.query).toBe(sql('11_claim_quote_followup_alerts.sql'));
    expect(claim.parameters.options.queryReplacement).toBe(
      '={{ [$env.LEAD_CHAT_QUOTE_SENT_BATCH_SIZE || 20, $env.LEAD_CHAT_QUOTE_SENT_SLA_MINUTES || 30, '
      + '$env.LEAD_CHAT_QUOTE_SENT_REALERT_HOURS || 24, $env.LEAD_CHAT_LEASE_STALE_SECONDS || 900] }}',
    );
    expect(claim.credentials).toEqual(node('Claim Expired Lead Chat Leases').credentials);
    expect(next('Claim Quote Follow-Up Alerts')).toEqual(['Prepare Quote Follow-Up Notice']);
  });

  test('the notice is sent through the outbound rail, one execution per alert', () => {
    expect(node('Prepare Quote Follow-Up Notice').parameters).toMatchObject({
      mode: 'runOnceForEachItem', jsCode: fixture('prepare-quote-followup-notice.js'),
    });
    expect(next('Prepare Quote Follow-Up Notice')).toEqual(['Send Quote Follow-Up Notice']);
    const send = node('Send Quote Follow-Up Notice');
    expect(send.type).toBe('n8n-nodes-base.executeWorkflow');
    expect(send.parameters).toMatchObject({
      mode: 'each',
      workflowId: { value: '77777777-0000-0000-0000-000000000001' },
      options: { waitForSubWorkflow: true },
    });
    expect(send.onError).toBe('continueRegularOutput');
    expect(next('Send Quote Follow-Up Notice')).toEqual(['Post Quote Follow-Up Comment']);
  });

  test('the comment node pairs by index and the completion closes by claim token', () => {
    expect(node('Post Quote Follow-Up Comment').parameters).toMatchObject({
      mode: 'runOnceForAllItems', jsCode: fixture('post-quote-followup-comment.js'),
    });
    expect(next('Post Quote Follow-Up Comment')).toEqual(['Complete Quote Follow-Up Alert']);
    const complete = node('Complete Quote Follow-Up Alert');
    expect(complete.parameters.query).toBe(sql('12_complete_quote_followup_alert.sql'));
    expect(complete.parameters.options.queryReplacement).toBe(
      '={{ [$json.ownership_id, $json.quote_alert_claim_token, $json.quote_alert_result, '
      + '$json.quote_alert_error, $json.comment_outcome] }}',
    );
    expect(next('Complete Quote Follow-Up Alert')).toEqual(['Finalize Lease Scheduler Branch']);
  });
});

describe('quote follow-up code nodes as n8n runs them', () => {
  test('the prepare node returns one item for its $json', () => {
    const out = new Function('$json', fixture('prepare-quote-followup-notice.js'))({
      ownership_id: 1, quote_alert_message_id: 2, clickup_task_id: 't', clickup_status: 'cotización enviada',
      seller_name: 'Juan Pablo (Pruebas)', waiting_minutes: 31, customer_messages: ['hola'],
    });
    expect(out.json.response_kind).toBe('quote_followup_notice');
    expect(out.json.response_text).toContain('Juan Pablo');
  });

  test('the comment node pairs each outbound result with its prepared alert', async () => {
    const calls = [];
    const helpers = { httpRequest: async (options) => { calls.push(options); return { statusCode: 200, body: {} }; } };
    const prepared = [
      { ownership_id: 1, quote_alert_claim_token: 'a', clickup_comment_url: 'https://x/1', clickup_comment_body: { comment_text: '1' } },
      { ownership_id: 2, quote_alert_claim_token: 'b', clickup_comment_url: 'https://x/2', clickup_comment_body: { comment_text: '2' } },
    ];
    const lookup = () => ({ all: () => prepared.map((json) => ({ json })) });
    const items = [{ json: { delivery_status: 'sent' } }, { json: { delivery_status: 'cancelled', human_control_cancelled: true } }];
    const out = await new Function('items', '$', 'helpers', '$env', fixture('post-quote-followup-comment.js'))(
      items, lookup, helpers, { CLICKUP_API_TOKEN: 'tok' },
    );
    expect(out.map((item) => item.json)).toEqual([
      expect.objectContaining({ ownership_id: 1, quote_alert_claim_token: 'a', quote_alert_result: 'sent', comment_outcome: 'posted' }),
      expect.objectContaining({ ownership_id: 2, quote_alert_claim_token: 'b', quote_alert_result: 'cancelled', comment_outcome: 'skipped_cancelled' }),
    ]);
    expect(calls.map((call) => call.url)).toEqual(['https://x/1']);
  });
});
