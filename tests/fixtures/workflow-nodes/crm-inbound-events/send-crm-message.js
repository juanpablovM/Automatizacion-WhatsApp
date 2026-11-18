// Send CRM Message: one POST to Evolution for the message.send intent that
// Claim CRM Message Send just moved to 'sending'. Never retried here: Evolution
// has no idempotency key, so a second POST after an ambiguous result could
// reach the customer twice. Every result, thrown errors included, becomes one
// item for Complete CRM Message Send (all values as text for the query). The
// API key never leaves this node.
const crmSendClaim = items[0]?.json ?? {};
const crmSendPrefix = readCrmMessageSendConfig($env).id_prefix ?? '';
const crmSendRequest = buildCrmEvolutionSendRequest(crmSendClaim, $env);

let crmSendResult;
if (!crmSendRequest.ok) {
  crmSendResult = { outcome: 'failed', provider_message_id: null, provider_status: null, error: crmSendRequest.error };
} else {
  try {
    const response = await helpers.httpRequest({
      method: 'POST',
      url: crmSendRequest.url,
      headers: { apikey: crmSendRequest.api_key, 'Content-Type': 'application/json' },
      body: crmSendRequest.body,
      json: true,
      returnFullResponse: true,
      ignoreHttpStatusErrors: true,
      timeout: 20000,
    });
    crmSendResult = classifyCrmEvolutionResult({ statusCode: response?.statusCode, body: response?.body });
  } catch (error) {
    crmSendResult = classifyCrmEvolutionResult({ error: { code: error?.code, message: error?.message } });
  }
}

return [{
  json: {
    outbound_id: String(crmSendClaim.outbound_id ?? ''),
    attempt: String(crmSendClaim.attempt ?? ''),
    outcome: crmSendResult.outcome,
    provider_message_id: crmSendResult.provider_message_id ?? '',
    provider_status: crmSendResult.provider_status === null ? '' : String(crmSendResult.provider_status),
    error: crmSendResult.error ?? '',
    id_prefix: crmSendPrefix,
  },
}];
