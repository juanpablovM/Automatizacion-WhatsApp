const row = items[0]?.json ?? {};

const statusCode = Number(row.statusCode_2 || row.statusCode || 0);
const responseBody = row.body_2 || row.body || {};
const retryAttempts = Number(row.retry_attempts_2 || row.retry_attempts || 1);
const retryExhausted = Boolean(row.retry_exhausted_2 || row.retry_exhausted || false);
const retryLastError = row.retry_last_error_2 || row.retry_last_error || null;
const messageId = row.id_1 || row.id || null;
const conversationId = row.conversation_id_1 || row.conversation_id || null;
const leadId = row.lead_id_1 || row.lead_id || null;
const responseKind = row.response_kind_1 || row.response_kind || 'system_message';
const externalMessageId = responseBody?.key?.id || responseBody?.data?.key?.id || null;
const rawPayload = row.raw_payload_1 || row.raw_payload || {};
const isV3Delivery = ['validated_conversation_decision/v3', 'system_contingency_decision/v3']
  .includes(rawPayload?.version);
const deliveryStatus = statusCode >= 200 && statusCode < 300
  ? 'sent'
  : (statusCode === 0 || statusCode >= 500 ? 'unknown' : 'failed');
const dispatchPhase = deliveryStatus;
const reconciliationRequired = deliveryStatus === 'unknown'
  || (isV3Delivery && deliveryStatus === 'failed');
const reconciliationReason = reconciliationRequired
  ? (retryLastError || `ambiguous_provider_outcome_status_${statusCode}`)
  : null;

return [
  {
    json: {
      message_id: messageId,
      conversation_id: conversationId,
      lead_id: leadId,
      delivery_status: deliveryStatus,
      dispatch_phase: dispatchPhase,
      reconciliation_required: reconciliationRequired,
      reconciliation_reason: reconciliationReason,
      external_message_id: externalMessageId,
      event_name: 'evolution_outbound_delivery',
      result: deliveryStatus,
      after_payload_json: JSON.stringify({
        status_code: statusCode,
        response_body: responseBody,
        retry_attempts: retryAttempts,
        retry_exhausted: retryExhausted,
        retry_last_error: retryLastError,
      }),
      metadata_json: JSON.stringify({
        response_kind: responseKind,
        provider: 'evolution_api',
        retry_attempts: retryAttempts,
        retry_exhausted: retryExhausted,
      }),
    },
  },
];
