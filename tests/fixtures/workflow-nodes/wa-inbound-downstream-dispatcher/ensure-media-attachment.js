// =============================================================================
// Ensure Media Attachment — A-009: fotos y archivos recibidos (P0).
// -----------------------------------------------------------------------------
// Nodo del dispatcher "WA - Inbound Downstream Dispatcher". SOURCE OF TRUTH
// de la politica de media: tipos permitidos, limites de tamano, validacion de
// host (misma instancia Evolution) y gate de extension `attached_to`
// (ClickUp CR-014 PENDIENTE, no implementado).
//
// El mismo archivo es, en pruebas (harness), un modulo Node: expone
// MEDIA_POLICY, MEDIA_BACKOFF_SECONDS, evaluateMediaPolicy,
// buildMediaDedupeKey, sanitizeLog, shouldAllowMediaHost y mediaScopeFor para
// tests de contrato. En n8n (Code node "Ensure Media Attachment") solo se
// ejecuta la seccion final que lee `items`.
//
// Contrato:
//   - Sin media (attachment_type nulo) -> media_skipped=true, NO escribe.
//   - Con media -> media_write=true: SIEMPRE se registra metadata (trazabilidad
//     sin perder el evento), incluso si la descarga luego se rechaza.
//   - Politica evaluada ANTES de descargar: tipo no permitido, tamano fuera de
//     limite o url de host no permitido -> download_state 'rejected' con
//     rejected_reason (no se descarga).
//   - El rail JAMAS bloquea la respuesta al cliente (carril lateral).
//   - Idempotencia: dedupe key 'media:<media_key>'; fallback 'url:<external_url>'
//     (el hash se une despues de descargar).
// =============================================================================

const MEDIA_POLICY = {
  allowed_types: ['image', 'document', 'audio', 'video'],
  max_bytes: {
    image: 25 * 1024 * 1024,
    document: 25 * 1024 * 1024,
    audio: 25 * 1024 * 1024,
    video: 50 * 1024 * 1024,
  },
};

const MEDIA_BACKOFF_SECONDS = 10;

const normalizeSize = (value) => {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number') return Number.isSafeInteger(value) ? value : null;
  if (typeof value === 'bigint') return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
};

const evaluateMediaPolicy = (row, policyOverride) => {
  const policy = policyOverride || MEDIA_POLICY;
  const type = String(row.attachment_type || '').trim();
  if (!type) return { allowed_download: false, decision: 'skipped', reason: 'no_media' };
  if (!policy.allowed_types.includes(type)) {
    return { allowed_download: false, decision: 'rejected', reason: 'unsupported_type' };
  }
  const declaredSize = normalizeSize(row.file_size);
  if (declaredSize !== null && declaredSize > policy.max_bytes[type]) {
    return { allowed_download: false, decision: 'rejected', reason: 'oversized_declared' };
  }
  if (!String(row.external_url || '').trim()) {
    return { allowed_download: false, decision: 'rejected', reason: 'missing_url' };
  }
  return { allowed_download: true, decision: 'proceed', reason: null };
};

const buildMediaDedupeKey = (row) => {
  const mediaKey = String(row.media_key || '').trim();
  if (mediaKey) return `media:${mediaKey}`;
  const url = String(row.external_url || '').trim();
  if (url) return `url:${url}`;
  return null;
};

const sanitizeLog = (value) => {
  const text = String(value ?? '');
  if (text.length <= 96) return text;
  return `${text.slice(0, 92)}...(${text.length} chars)`;
};

const shouldAllowMediaHost = (url, allowedHosts) => {
  if (!url) return false;
  let parsed;
  try {
    parsed = new URL(url);
  } catch (_error) {
    return false;
  }
  const hosts = (allowedHosts || [])
    .map((host) => String(host).trim())
    .filter(Boolean);
  if (hosts.length === 0) return true;
  return hosts.includes(parsed.host) || hosts.includes(parsed.hostname);
};

const mediaScopeFor = (row, env = {}) => {
  const conversationId = Number(row.conversation_id);
  const inboundEventId = Number(row.inbound_event_id);
  const type = String(row.attachment_type || '').trim();

  const envMaxBytes = {};
  for (const mediaType of MEDIA_POLICY.allowed_types) {
    const envKey = `MEDIA_MAX_BYTES_${mediaType.toUpperCase()}`;
    const raw = env[envKey];
    if (raw !== undefined && raw !== null && raw !== '') {
      const parsed = Number(raw);
      if (Number.isFinite(parsed) && parsed > 0) envMaxBytes[mediaType] = parsed;
    }
  }
  const allowedHosts = String(env.MEDIA_ALLOWED_HOSTS || '')
    .split(',')
    .map((host) => host.trim())
    .filter(Boolean);

  const policy = {
    allowed_types: MEDIA_POLICY.allowed_types,
    max_bytes: { ...MEDIA_POLICY.max_bytes, ...envMaxBytes },
  };
  const evaluation = evaluateMediaPolicy(row, policy);
  const hostAllowed = shouldAllowMediaHost(String(row.external_url || '').trim(), allowedHosts);
  const rejectedByHost = evaluation.decision === 'proceed' && !hostAllowed;

  return {
    media_write: evaluation.decision !== 'skipped',
    media_skipped: evaluation.decision === 'skipped',
    media_scope: {
      media_key: String(row.media_key || '').trim() || null,
      external_url: String(row.external_url || '').trim() || null,
      media_url_log: sanitizeLog(row.external_url || ''),
      message_id: String(row.external_message_id || row.message_id || '').trim() || null,
      inbound_event_id: Number.isSafeInteger(inboundEventId) && inboundEventId > 0 ? inboundEventId : null,
      conversation_id: Number.isSafeInteger(conversationId) && conversationId > 0 ? conversationId : null,
      source_number_id: Number(row.source_number_id) > 0 ? Number(row.source_number_id) : null,
      instance_name: String(row.instance_name || '').trim() || null,
      phone_number: String(row.phone_number || '').trim() || null,
      attachment_type: type || null,
      mime_type: String(row.mime_type || '').trim() || null,
      filename: String(row.filename || '').trim() || null,
      file_size: normalizeSize(row.file_size),
      policy: {
        allowed_download: evaluation.allowed_download && hostAllowed,
        reason: rejectedByHost ? 'host_not_allowed' : evaluation.reason,
      },
      dedupe_key: buildMediaDedupeKey(row),
      url_host_allowed: hostAllowed,
      download_state: evaluation.decision === 'proceed'
        ? (hostAllowed ? 'pending' : 'rejected')
        : (evaluation.decision === 'skipped' ? 'pending' : 'rejected'),
      rejected_reason: rejectedByHost ? 'host_not_allowed' : evaluation.reason,
      attach_pending: false,
      attached_to: null,
    },
  };
};

// =============================================================================
// Seccion n8n (Code node): procesa el item de entrada del dispatcher.
// En Node (harness) `items` no existe y este bloque no se ejecuta.
// =============================================================================
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    MEDIA_POLICY,
    MEDIA_BACKOFF_SECONDS,
    normalizeSize,
    evaluateMediaPolicy,
    buildMediaDedupeKey,
    sanitizeLog,
    shouldAllowMediaHost,
    mediaScopeFor,
  };
}

if (typeof items !== 'undefined') {
  const row = items[0]?.json ?? {};
  const decision = mediaScopeFor(row, $env ?? {});
  const scope = decision.media_scope;
  return [{
    json: {
      ...row,
      ...scope,
      media_write: decision.media_write,
      media_skipped: decision.media_skipped,
      media_scope: scope,
    },
  }];
}