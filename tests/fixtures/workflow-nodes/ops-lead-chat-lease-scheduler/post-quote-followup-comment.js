// =============================================================================
// OPS - Lead Chat Lease Scheduler — Post Quote Follow-Up Comment
// -----------------------------------------------------------------------------
// Migration 037. Runs after "Send Quote Follow-Up Notice" (WA - Outbound
// Messages, one execution per item, paired by index exactly like the
// follow-up scheduler's "Normalize Follow-Up Delivery"). For each alert it:
//   1. classifies the notice delivery: sent | cancelled | failed | unknown;
//   2. posts the ClickUp comment to the seller, assigned to them, unless the
//      notice was cancelled because the seller was answering at that moment;
//   3. returns the completion input of 12_complete_quote_followup_alert.sql.
// The comment is one POST, never retried here: a lost comment is recorded in
// comment_outcome and never re-sends the customer notice. The task status is
// never read or written.
// =============================================================================

const configured = (value) => Boolean(value) && !String(value).includes('__PENDIENTE__');

const deliveryOutcomeOf = (outbound = {}) => {
  const status = String(outbound.delivery_status || outbound.outbound_dispatch_status || '').trim();
  if (status === 'sent' || status === 'already_sent') return 'sent';
  if (status === 'cancelled' || outbound.human_control_cancelled === true) return 'cancelled';
  if (status === 'failed' || outbound.error) return 'failed';
  return 'unknown';
};

const postComment = async (origin, httpRequest, env) => {
  if (!configured(env.CLICKUP_API_TOKEN)) return 'skipped_token_missing';
  if (!origin.clickup_comment_url) return 'skipped_task_missing';
  try {
    const response = await httpRequest({
      method: 'POST',
      url: origin.clickup_comment_url,
      headers: { Authorization: env.CLICKUP_API_TOKEN, 'Content-Type': 'application/json' },
      body: origin.clickup_comment_body || {},
      json: true,
      returnFullResponse: true,
      ignoreHttpStatusErrors: true,
      timeout: 30000,
    });
    const statusCode = Number(response?.statusCode || 0);
    return statusCode >= 200 && statusCode < 300 ? 'posted' : `failed_http_${statusCode}`;
  } catch (_error) {
    return 'failed_transport';
  }
};

const finalizeQuoteFollowupAlert = async (origin, outbound, httpRequest, env = {}) => {
  const result = deliveryOutcomeOf(outbound || {});
  const errorText = String(outbound?.error?.message || outbound?.message || '').trim();
  const commentOutcome = result === 'cancelled'
    ? 'skipped_cancelled'
    : await postComment(origin, httpRequest, env);
  return {
    ownership_id: origin.ownership_id ?? null,
    quote_alert_claim_token: origin.quote_alert_claim_token ?? null,
    quote_alert_result: result,
    quote_alert_error: result === 'sent' ? null : (errorText || `outbound_${result}`),
    comment_outcome: commentOutcome,
    outbound_message_id: outbound?.message_id || null,
  };
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { configured, deliveryOutcomeOf, finalizeQuoteFollowupAlert };
}

if (typeof items !== 'undefined') {
  let origins = [];
  try { origins = $('Prepare Quote Follow-Up Notice').all().map((item) => item.json || {}); } catch (_error) { origins = []; }
  // Sequential on purpose: one ClickUp call at a time per tick.
  return (async () => {
    const output = [];
    for (let index = 0; index < items.length; index += 1) {
      output.push({ json: await finalizeQuoteFollowupAlert(
        origins[index] || {},
        items[index].json || {},
        helpers.httpRequest.bind(helpers),
        typeof $env !== 'undefined' ? $env : {},
      ) });
    }
    return output;
  })();
}
