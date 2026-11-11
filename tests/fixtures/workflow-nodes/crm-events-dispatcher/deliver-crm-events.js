// Deliver CRM Events: POST each claimed event's stored body string, unchanged,
// with a fresh timestamp and signature. The body goes out as the raw string
// (json: false) so the bytes the CRM hashes are the bytes stored in
// crm_events.body. Neither the secret nor the body is ever returned or logged.
const crmCrypto = require('crypto');
const deliverConfig = readCrmEventsConfig($env);
if (!deliverConfig.enabled) return [];
if (deliverConfig.errors.length > 0) {
  throw new Error(`CRM events misconfigured: ${deliverConfig.errors.join(', ')}`);
}
const deliverSecret = String($env.CRM_EVENTS_HMAC_SECRET);
const httpRequest = helpers.httpRequest.bind(helpers);

const deliverOne = async (row) => {
  const attempt = Number(row.attempt_count) || 1;
  let response;
  try {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = signCrmRequest(row.body, deliverSecret, timestamp, crmCrypto);
    response = await httpRequest({
      method: 'POST',
      url: deliverConfig.url,
      headers: { 'Content-Type': 'application/json', ...signature },
      body: row.body,
      json: false,
      returnFullResponse: true,
      ignoreHttpStatusErrors: true,
      timeout: deliverConfig.timeout_ms,
    });
  } catch (error) {
    response = { error };
  }
  const classified = classifyCrmResponse(response, row.event_id);
  let outcome = classified.outcome;
  let error = classified.error;
  let retryDelay = null;
  if (outcome === 'retry') {
    if (attempt >= deliverConfig.max_attempts) {
      outcome = 'parked';
      error = `max_attempts_exhausted:${classified.error}`;
    } else {
      retryDelay = retryDelaySeconds(attempt, {
        base_seconds: deliverConfig.retry_base_seconds,
        cap_seconds: deliverConfig.retry_max_seconds,
      });
    }
  }
  return {
    crm_event_id: Number(row.crm_event_id),
    event_id: row.event_id,
    claim_token: row.claim_token,
    attempt_count: attempt,
    delivery_outcome: outcome,
    http_status: classified.http_status,
    delivery_error: error,
    response_json: classified.response_json,
    crm_customer_id: classified.crm_customer_id,
    crm_opportunity_id: classified.crm_opportunity_id,
    retry_delay_seconds: retryDelay,
  };
};

const delivered = [];
for (const row of items.map((item) => item.json ?? {}).filter(isClaimedCrmEvent)) {
  delivered.push({ json: await deliverOne(row) });
}
return delivered;
