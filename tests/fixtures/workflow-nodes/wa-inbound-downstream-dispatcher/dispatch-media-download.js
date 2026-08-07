// =============================================================================
// Dispatch Media Download — descarga determinista (stub) + hash (A-009).
// -----------------------------------------------------------------------------
// Ejecuta la descarga a traves de `backend` (inyectable/mockeable, sin red) y
// calcula el SHA-256 real de los bytes recibidos.
//
// Contrato del backend (determinista para tests):
//   backend.fetch(manifest) -> { status: number, bytes?: Buffer|Uint8Array,
//                                 error?: string }
//
// Outcomes:
//   - 200 con bytes <= max_bytes        -> 'downloaded' (hash real de bytes).
//   - 200 con bytes > max_bytes        -> 'rejected' ('oversized_actual';
//                                          no se persiste el binario).
//   - 410/404 con 'expired'            -> 'expired' (url vencida; el mensaje
//                                          NO se pierde: message_id queda).
//   - 4xx/5xx/error                    -> 'failed' (reintento con backoff).
//
// Protecciones:
//   - La url debe pasar la allowlist del rail (policy.allowed_download); si
//     no, 'failed' con 'host_not_allowed' y el backend NO se toca.
//   - El hash se calcula SOLO sobre bytes en memoria; nunca se loguea ni
//     audita el binario; `storage_path` es relativo/interno (sin rutas
//     absolutas del sistema) y `storage_token` es un id generico.
// =============================================================================

const crypto = require('crypto');

const sha256Of = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

const dispatchDownload = (manifest, backend, scope = {}) => {
  if (!manifest || !manifest.url) {
    return { outcome: 'failed', error: 'missing_url', attempt_spent: false };
  }
  if (scope.policy && scope.policy.allowed_download === false) {
    return { outcome: 'failed', error: scope.policy.reason || 'host_not_allowed', attempt_spent: false };
  }

  let response;
  try {
    response = backend.fetch(manifest);
  } catch (error) {
    return { outcome: 'failed', error: String(error?.message || 'backend_error'), attempt_spent: true };
  }

  const status = Number(response?.status) || 0;
  const error = String(response?.error || '').trim();

  if (status === 410 || (status >= 400 && error.includes('expired'))) {
    return { outcome: 'expired', error: error || 'media_expired', attempt_spent: true };
  }

  const raw = response?.bytes;
  const bytes = raw instanceof Uint8Array ? Buffer.from(raw) : raw;
  if (!Buffer.isBuffer(bytes)) {
    return { outcome: 'failed', error: error || 'no_bytes', attempt_spent: true };
  }

  if (bytes.length > manifest.max_bytes) {
    return {
      outcome: 'rejected',
      error: 'oversized_actual',
      reason: 'oversized_actual',
      bytes_length: bytes.length,
      max_bytes: manifest.max_bytes,
      attempt_spent: true,
    };
  }

  return {
    outcome: 'downloaded',
    sha256: sha256Of(bytes),
    bytes_length: bytes.length,
    storage_token: `m-${crypto.randomBytes(4).toString('hex')}`,
    storage_path: `media/${manifest.attachment_type || 'file'}/${crypto.randomBytes(4).toString('hex')}`,
    attempt_spent: true,
  };
};

// =============================================================================
// Seccion n8n (Code node): procesa el item de entrada del dispatcher.
// En Node (harness) `items` no existe y este bloque no se ejecuta.
// =============================================================================
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    sha256Of,
    dispatchDownload,
  };
}

if (typeof items !== 'undefined') {
  const row = items[0]?.json ?? {};
  const manifest = row.download_manifest ?? {};
  const backend = row.media_backend ?? { fetch: () => ({ status: 503, error: 'no_backend_configured' }) };
  const outcome = dispatchDownload(manifest, backend, row.media_scope ?? {});
  return [{
    json: {
      ...row,
      media_download: {
        outcome: outcome.outcome,
        sha256: outcome.sha256 ?? null,
        bytes_length: outcome.bytes_length ?? null,
        error: outcome.error ?? null,
        rejected_reason: outcome.reason ?? null,
        storage_token: outcome.storage_token ?? null,
        storage_path: outcome.storage_path ?? null,
        attempt_spent: Boolean(outcome.attempt_spent),
      },
    },
  }];
}