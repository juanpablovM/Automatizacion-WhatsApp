// =============================================================================
// Prepare Media Download — contrato de descarga determinista (A-009).
// -----------------------------------------------------------------------------
// Decide SI se descarga y CON QUE configuracion, a partir del estado
// persistido (download_state, retry_count, max_retries) y de la politica de
// media evaluada por "Ensure Media Attachment".
//
// Contrato:
//   - pending + intentos disponibles -> should_download=true con manifiesto.
//   - pending pero retry_count >= max_retries -> no descarga.
//   - estado terminal (downloaded/rejected/expired/exhausted) -> no descarga
//     (nunca se vuelve a bajar una media rechazada ni expirada).
//   - downloaded -> no descarga (el binario ya existe; idempotencia).
//
// El `download_manifest` expone la url COMPLETA solo como campo interno del
// rail (lo consume Dispatch en el mismo turno y el apply marca el intento).
// Para logging se usa el truncado `media_url_log`; ningun log de este carril
// emite la url completa.
// =============================================================================

const MEDIA_DEFAULT_MAX_BYTES = {
  image: 25 * 1024 * 1024,
  document: 25 * 1024 * 1024,
  audio: 25 * 1024 * 1024,
  video: 50 * 1024 * 1024,
};

const shouldDownload = (scope, row = {}) => {
  const state = String(row.media_download_state || scope.download_state || '').trim();
  const retryCount = Number(scope.retry_count ?? row.retry_count ?? 0) || 0;
  const maxRetries = Number(scope.max_retries ?? row.max_retries ?? 3) || 3;

  if (state === 'downloaded') return false;
  if (state === 'rejected') return false;
  if (state === 'expired') return false;
  if (state === 'exhausted') return false;
  if (retryCount >= maxRetries) return false;

  return true;
};

const buildDownloadManifest = (scope, row = {}, env = {}) => {
  const url = String(scope.external_url || row.external_url || '').trim();
  const mediaKey = String(scope.media_key || row.media_key || '').trim();
  const type = String(scope.attachment_type || row.attachment_type || '').trim();
  const mimeType = String(scope.mime_type || row.mime_type || '').trim();
  const envMax = Number(env[`MEDIA_MAX_BYTES_${type.toUpperCase()}`]);
  const maxBytes = Number.isFinite(envMax) && envMax > 0
    ? envMax
    : MEDIA_DEFAULT_MAX_BYTES[type] || 25 * 1024 * 1024;

  return {
    url,
    media_key: mediaKey || null,
    attachment_type: type,
    mime_type: mimeType,
    max_bytes: maxBytes,
    expected_sha256: String(row.sha256 || '') || null,
    dedupe_key: String(scope.dedupe_key || row.dedupe_key || '').trim() || null,
    storage_strategy: 'local_relative',
  };
};

// =============================================================================
// Seccion n8n (Code node): procesa el item de entrada del dispatcher.
// En Node (harness) `items` no existe y este bloque no se ejecuta.
// =============================================================================
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    shouldDownload,
    buildDownloadManifest,
  };
}

if (typeof items !== 'undefined') {
  const row = items[0]?.json ?? {};
  const scope = row.media_scope ?? {};
  const wantsDownload = shouldDownload(scope, row);
  return [{
    json: {
      ...row,
      should_download: wantsDownload,
      download_manifest: wantsDownload ? buildDownloadManifest(scope, row, $env ?? {}) : null,
    },
  }];
}