const row = items[0]?.json ?? {};

const phoneNumber = String(row.phone_number || '').trim();
const instanceName = String(row.instance_name || $env.EVOLUTION_DEFAULT_INSTANCE || '').trim();
const messageText = String(row.response_text || row.text_body || '').trim();
const conversationId = row.conversation_id ?? null;
const leadId = row.lead_id ?? null;
const responseKind = row.response_kind || 'system_message';
const apiBaseUrl = String($env.EVOLUTION_API_BASE_URL || '').replace(/\/$/, '');
const apiKey = String($env.EVOLUTION_API_KEY || '').trim();

if (!conversationId) {
  throw new Error('WA - Outbound Messages requiere conversation_id');
}

if (!phoneNumber) {
  throw new Error('WA - Outbound Messages requiere phone_number');
}

if (!messageText) {
  throw new Error('WA - Outbound Messages requiere response_text o text_body');
}

if (!instanceName) {
  throw new Error('WA - Outbound Messages requiere instance_name o EVOLUTION_DEFAULT_INSTANCE');
}

if (!apiBaseUrl || !apiKey) {
  throw new Error('Evolution API no esta configurada en variables de entorno');
}

const stableHash = (value) => {
  let hash = 2166136261;
  for (const char of String(value || '')) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
};
const triggerKey = row.message_id || row.external_message_id || `text:${stableHash(messageText)}`;
const idempotencyKey = row.delivery_key
  || row.idempotency_key
  || `evolution:${instanceName}:${conversationId}:${triggerKey}:${responseKind}`;

const outboundBody = {
  number: phoneNumber,
  text: messageText,
  delay: 0,
  linkPreview: false,
};

return [
  {
    json: {
      conversation_id: conversationId,
      lead_id: leadId,
      phone_number: phoneNumber,
      instance_name: instanceName,
      message_type: 'text',
      text_body: messageText,
      response_kind: responseKind,
      outbound_url: `${apiBaseUrl}/message/sendText/${encodeURIComponent(instanceName)}`,
      outbound_body: outboundBody,
      raw_payload_json: JSON.stringify(outboundBody),
      outbound_claim_stale_seconds: Math.max(30, Number($env.OUTBOUND_CLAIM_STALE_SECONDS || 300)),
      idempotency_key: idempotencyKey,
    },
  },
];
