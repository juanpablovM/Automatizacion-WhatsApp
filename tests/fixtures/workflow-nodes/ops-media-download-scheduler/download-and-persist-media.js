const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const configured = (value) => Boolean(String(value || '').trim()) && !String(value).includes('__PENDIENTE__');
const normalizeBody = (body) => {
  if (typeof body !== 'string') return body || {};
  try { return JSON.parse(body); } catch (_error) { return { raw: body }; }
};
const outcome = (row, mediaOutcome, options = {}) => ({
  ...row,
  media_outcome: mediaOutcome,
  media_sha256: options.sha256 || null,
  media_bytes_length: options.bytesLength ?? null,
  media_storage_path: options.storagePath || null,
  media_storage_token: options.storageToken || null,
  media_error: options.error || null,
  media_http_status: options.httpStatus || 0,
});

const mimeCategory = (mime) => {
  const value = String(mime || '').split(';')[0].trim().toLowerCase();
  if (value.startsWith('image/')) return 'image';
  if (value.startsWith('audio/')) return 'audio';
  if (value.startsWith('video/')) return 'video';
  return value ? 'document' : null;
};

const extractBase64 = (body) => {
  const source = body?.base64 ?? body?.data?.base64 ?? body?.data ?? null;
  if (typeof source !== 'string') return { error: 'base64_missing' };
  const trimmed = source.trim();
  const dataUrl = trimmed.match(/^data:([^;,]+);base64,(.*)$/s);
  return {
    encoded: dataUrl ? dataUrl[2] : trimmed,
    dataUrlMime: dataUrl ? dataUrl[1].toLowerCase() : null,
  };
};

const decodeBase64Bounded = (encoded, maxBytes) => {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) return { error: 'max_bytes_invalid' };
  if (!encoded || encoded.length > 4 * Math.ceil(maxBytes / 3) + 4) return { error: 'oversized_encoded' };
  if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return { error: 'invalid_base64' };
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length > maxBytes) return { error: 'oversized_actual', bytesLength: bytes.length };
  const canonical = bytes.toString('base64').replace(/=+$/, '');
  if (canonical !== encoded.replace(/=+$/, '')) return { error: 'invalid_base64' };
  return { bytes };
};

const normalizeExpectedSha256 = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return { value: null, error: null };
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return { value: raw.toLowerCase(), error: null };
  if (!/^[A-Za-z0-9+/]{43}=$/.test(raw)) return { value: null, error: 'expected_sha256_invalid' };
  const bytes = Buffer.from(raw, 'base64');
  if (bytes.length !== 32 || bytes.toString('base64') !== raw) return { value: null, error: 'expected_sha256_invalid' };
  return { value: bytes.toString('hex'), error: null };
};

const persistAtomic = (bytes, sha256, storageRoot, claimToken) => {
  const root = path.resolve(storageRoot);
  const relativePath = path.posix.join('media', sha256.slice(0, 2), sha256);
  const directory = path.join(root, 'media', sha256.slice(0, 2));
  const finalPath = path.join(directory, sha256);
  if (!finalPath.startsWith(`${root}${path.sep}`)) throw new Error('storage_path_escape');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });

  if (fs.existsSync(finalPath)) {
    const existing = fs.readFileSync(finalPath);
    const existingHash = crypto.createHash('sha256').update(existing).digest('hex');
    if (existingHash !== sha256 || existing.length !== bytes.length) throw new Error('storage_hash_collision');
    return relativePath;
  }

  const safeToken = String(claimToken || 'claim').replace(/[^a-zA-Z0-9-]/g, '');
  const temporaryPath = path.join(directory, `.${sha256}.${safeToken}.tmp`);
  let descriptor;
  try {
    descriptor = fs.openSync(temporaryPath, 'wx', 0o600);
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporaryPath, finalPath);
    fs.chmodSync(finalPath, 0o600);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
  }
  return relativePath;
};

const downloadAndPersistMedia = async (row, env, httpRequest, persist = persistAtomic) => {
  const baseUrl = String(env.EVOLUTION_API_BASE_URL || '').trim().replace(/\/+$/, '');
  const apiKey = String(env.EVOLUTION_API_KEY || '').trim();
  const storageRoot = String(env.MEDIA_STORAGE_ROOT || '/data/media').trim();
  const instance = String(row.instance_name || env.EVOLUTION_DEFAULT_INSTANCE || '').trim();
  if (!configured(baseUrl) || !configured(apiKey) || !configured(storageRoot) || !instance) {
    return outcome(row, 'deferred', { error: 'media_configuration_missing' });
  }
  if (path.resolve(storageRoot) !== '/data/media') {
    return outcome(row, 'deferred', { error: 'media_storage_root_must_be_/data/media' });
  }

  const raw = row.raw_payload && typeof row.raw_payload === 'object' ? row.raw_payload : {};
  const message = raw.data ?? raw.message ?? raw;
  if (!message || (typeof message === 'object' && Object.keys(message).length === 0)) {
    return outcome(row, 'rejected', { error: 'raw_media_message_missing' });
  }
  const expected = normalizeExpectedSha256(row.expected_sha256);
  if (expected.error) return outcome(row, 'rejected', { error: expected.error });

  let response;
  try {
    response = await httpRequest({
      method: 'POST',
      url: `${baseUrl}/chat/getBase64FromMediaMessage/${encodeURIComponent(instance)}`,
      headers: { apikey: apiKey, 'Content-Type': 'application/json' },
      body: { message },
      json: true,
      returnFullResponse: true,
      ignoreHttpStatusErrors: true,
      timeout: Number(env.MEDIA_DOWNLOAD_TIMEOUT_MS || 30000),
    });
  } catch (error) {
    return outcome(row, 'failed', { error: String(error?.message || 'evolution_transport_error') });
  }

  const status = Number(response?.statusCode || 0);
  const body = normalizeBody(response?.body);
  if (status === 401 || status === 403) return outcome(row, 'deferred', { error: `evolution_http_${status}`, httpStatus: status });
  if ([400, 404, 410].includes(status)) return outcome(row, 'expired', { error: `evolution_http_${status}`, httpStatus: status });
  if (status === 429 || status >= 500 || status === 0) return outcome(row, 'failed', { error: `evolution_http_${status}`, httpStatus: status });
  if (status < 200 || status >= 300) return outcome(row, 'rejected', { error: `evolution_http_${status}`, httpStatus: status });

  const extracted = extractBase64(body);
  if (extracted.error) return outcome(row, 'rejected', { error: extracted.error, httpStatus: status });
  const decoded = decodeBase64Bounded(extracted.encoded, Number(row.max_bytes));
  if (decoded.error) return outcome(row, 'rejected', { error: decoded.error, bytesLength: decoded.bytesLength, httpStatus: status });

  const responseMime = String(body?.mimetype || body?.mimeType || body?.data?.mimetype || extracted.dataUrlMime || '').toLowerCase();
  const expectedCategory = String(row.attachment_type || '').toLowerCase();
  if (!responseMime || mimeCategory(responseMime) !== expectedCategory) {
    return outcome(row, 'rejected', { error: 'mime_category_mismatch', bytesLength: decoded.bytes.length, httpStatus: status });
  }
  const expectedMime = String(row.mime_type || '').split(';')[0].trim().toLowerCase();
  if (expectedMime && responseMime.split(';')[0].trim() !== expectedMime) {
    return outcome(row, 'rejected', { error: 'mime_type_mismatch', bytesLength: decoded.bytes.length, httpStatus: status });
  }

  const sha256 = crypto.createHash('sha256').update(decoded.bytes).digest('hex');
  const expectedHash = expected.value;
  if (expectedHash && expectedHash !== sha256) {
    return outcome(row, 'rejected', { error: 'sha256_mismatch', sha256, bytesLength: decoded.bytes.length, httpStatus: status });
  }

  try {
    const storagePath = persist(decoded.bytes, sha256, storageRoot, row.claim_token);
    return outcome(row, 'downloaded', {
      sha256,
      bytesLength: decoded.bytes.length,
      storagePath,
      storageToken: `sha256:${sha256}`,
      httpStatus: status,
    });
  } catch (error) {
    return outcome(row, 'failed', { error: String(error?.message || 'media_storage_error'), httpStatus: status });
  }
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { configured, normalizeBody, mimeCategory, extractBase64, decodeBase64Bounded, normalizeExpectedSha256, persistAtomic, downloadAndPersistMedia };
}

if (typeof items !== 'undefined') {
  return downloadAndPersistMedia(items[0]?.json ?? {}, $env ?? {}, helpers.httpRequest.bind(helpers))
    .then((result) => [{ json: result }]);
}
