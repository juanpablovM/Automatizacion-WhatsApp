const retryableStatusCodes = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
// Evolution does not expose a request idempotency key. Retrying a POST after an
// ambiguous timeout can duplicate a WhatsApp message, so each claimed operation
// is sent at most once and ambiguous results are reconciled operationally.
const maxAttempts = 1;
const baseDelayMs = Number($env.EXTERNAL_HTTP_RETRY_BASE_MS || 1000);
const maxDelayMs = Number($env.EXTERNAL_HTTP_RETRY_MAX_MS || 10000);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const retryDelay = (attempt) => {
  const exponential = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt - 1));
  const jitter = Math.floor(Math.random() * 250);
  return exponential + jitter;
};

const normalizeBody = (value) => {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch (_error) {
      return { raw: value };
    }
  }
  return value || {};
};

const row = items[0]?.json ?? {};
const instanceName = String(row.instance_name || $env.EVOLUTION_DEFAULT_INSTANCE || '').trim();
const apiBaseUrl = String($env.EVOLUTION_API_BASE_URL || '').replace(/\/$/, '');
const url = String(row.outbound_url || (apiBaseUrl && instanceName ? `${apiBaseUrl}/message/sendText/${encodeURIComponent(instanceName)}` : '')).trim();
const body = row.outbound_body || row.raw_payload;

if (row.already_sent === true || row.should_send === false) {
  return [];
}

if (!url) throw new Error('Send Evolution Message requiere outbound_url');
if (!body) throw new Error('Send Evolution Message requiere outbound_body');

let lastError = null;

for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
  try {
    const response = await helpers.httpRequest({
      method: 'POST',
      url,
      headers: {
        apikey: $env.EVOLUTION_API_KEY,
        'Content-Type': 'application/json',
      },
      body,
      json: true,
      returnFullResponse: true,
      ignoreHttpStatusErrors: true,
    });

    const statusCode = Number(response.statusCode || 0);
    const shouldRetry = retryableStatusCodes.has(statusCode) && attempt < maxAttempts;
    if (!shouldRetry) {
      return [
        {
          json: {
            ...row,
            statusCode,
            body: normalizeBody(response.body),
            headers: response.headers || {},
            retry_attempts: attempt,
            retry_exhausted: retryableStatusCodes.has(statusCode) && attempt >= maxAttempts,
            retry_last_error: null,
          },
        },
      ];
    }
  } catch (error) {
    lastError = error;
    if (attempt >= maxAttempts) {
      return [
        {
          json: {
            ...row,
            statusCode: 0,
            body: { message: error.message },
            headers: {},
            retry_attempts: attempt,
            retry_exhausted: true,
            retry_last_error: error.message,
          },
        },
      ];
    }
  }

  await sleep(retryDelay(attempt));
}

return [{ json: { ...row, statusCode: 0, body: { message: lastError?.message || 'HTTP retry exhausted' }, headers: {}, retry_attempts: maxAttempts, retry_exhausted: true, retry_last_error: lastError?.message || null } }];
