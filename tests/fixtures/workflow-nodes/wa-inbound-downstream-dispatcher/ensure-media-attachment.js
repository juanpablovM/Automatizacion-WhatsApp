// Build the durable metadata record for inbound media. Downloading happens only
// through Evolution's fixed internal getBase64FromMediaMessage endpoint.

const MEDIA_POLICY = {
  allowed_types: ['image', 'document', 'audio', 'video'],
  max_bytes: {
    image: 25 * 1024 * 1024,
    document: 25 * 1024 * 1024,
    audio: 25 * 1024 * 1024,
    video: 50 * 1024 * 1024,
  },
};

const normalizeSize = (value) => {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
};

const evaluateMediaPolicy = (row, policy = MEDIA_POLICY) => {
  const type = String(row.attachment_type || '').trim().toLowerCase();
  if (!type) return { decision: 'skipped', reason: 'no_media', max_bytes: null };
  if (!policy.allowed_types.includes(type)) {
    return { decision: 'rejected', reason: 'unsupported_type', max_bytes: null };
  }
  const maxBytes = policy.max_bytes[type];
  const declaredSize = normalizeSize(row.file_size);
  if (declaredSize !== null && declaredSize > maxBytes) {
    return { decision: 'rejected', reason: 'oversized_declared', max_bytes: maxBytes };
  }
  return { decision: 'proceed', reason: null, max_bytes: maxBytes };
};

const buildMediaDedupeKey = (row) => {
  const mediaKey = String(row.media_key || row.external_media_id || '').trim();
  if (mediaKey) return `media:${mediaKey}`;
  const messageId = String(row.external_message_id || row.message_id || '').trim();
  return messageId ? `message:${messageId}` : null;
};

const parseRawPayload = (row) => {
  if (row.raw_payload && typeof row.raw_payload === 'object') return { value: row.raw_payload, error: null };
  if (typeof row.raw_payload_json !== 'string' || !row.raw_payload_json.trim()) {
    return { value: {}, error: 'raw_payload_missing' };
  }
  try {
    const parsed = JSON.parse(row.raw_payload_json);
    return parsed && typeof parsed === 'object'
      ? { value: parsed, error: null }
      : { value: {}, error: 'raw_payload_invalid' };
  } catch (_error) {
    return { value: {}, error: 'raw_payload_invalid' };
  }
};

const mediaScopeFor = (row, env = {}) => {
  const policy = {
    allowed_types: MEDIA_POLICY.allowed_types,
    max_bytes: { ...MEDIA_POLICY.max_bytes },
  };
  for (const type of policy.allowed_types) {
    const configured = Number(env[`MEDIA_MAX_BYTES_${type.toUpperCase()}`]);
    if (Number.isSafeInteger(configured) && configured > 0) policy.max_bytes[type] = configured;
  }

  const evaluation = evaluateMediaPolicy(row, policy);
  const parsedPayload = parseRawPayload(row);
  const payloadRejected = evaluation.decision === 'proceed' && parsedPayload.error;
  const conversationId = Number(row.conversation_id);
  const inboundEventId = Number(row.inbound_event_id);
  const sourceNumberId = Number(row.source_number_id);

  return {
    ...row,
    media_write: evaluation.decision !== 'skipped',
    media_skipped: evaluation.decision === 'skipped',
    media_scope: {
      media_key: String(row.media_key || row.external_media_id || '').trim() || null,
      external_url: String(row.external_url || '').trim() || null,
      message_id: String(row.external_message_id || row.message_id || '').trim() || null,
      inbound_event_id: Number.isSafeInteger(inboundEventId) && inboundEventId > 0 ? inboundEventId : null,
      conversation_id: Number.isSafeInteger(conversationId) && conversationId > 0 ? conversationId : null,
      source_number_id: Number.isSafeInteger(sourceNumberId) && sourceNumberId > 0 ? sourceNumberId : null,
      instance_name: String(row.instance_name || '').trim() || null,
      phone_number: String(row.phone_number || '').trim() || null,
      attachment_type: String(row.attachment_type || '').trim().toLowerCase() || null,
      mime_type: String(row.mime_type || '').trim().toLowerCase() || null,
      filename: String(row.filename || '').trim() || null,
      file_size: normalizeSize(row.file_size),
      expected_sha256: String(row.sha256 || '').trim() || null,
      max_bytes: evaluation.max_bytes,
      dedupe_key: buildMediaDedupeKey(row),
      raw_payload: parsedPayload.value,
      download_state: evaluation.decision === 'rejected' || payloadRejected ? 'rejected' : 'pending',
      rejected_reason: payloadRejected ? parsedPayload.error : evaluation.reason,
      attach_pending: false,
      attached_to: null,
    },
  };
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { MEDIA_POLICY, normalizeSize, evaluateMediaPolicy, buildMediaDedupeKey, parseRawPayload, mediaScopeFor };
}

if (typeof items !== 'undefined') {
  return [{ json: mediaScopeFor(items[0]?.json ?? {}, $env ?? {}) }];
}
