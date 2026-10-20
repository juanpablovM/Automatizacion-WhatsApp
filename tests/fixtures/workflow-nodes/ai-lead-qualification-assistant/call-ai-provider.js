const row = items[0]?.json ?? {};

if (row.ai_skipped) {
  return [{ json: { ...row, ai_status_code: null, ai_response: null, ai_retry_attempts: 0 } }];
}

if (row.ai_request_error || !row.ai_request) {
  return [{
    json: {
      ...row,
      ai_status_code: 0,
      ai_response: { error: { message: row.ai_request_error || 'missing_ai_request' } },
      ai_retry_attempts: 0,
      ai_retry_exhausted: false,
      ai_retry_last_error: row.ai_request_error || 'missing_ai_request',
    },
  }];
}

const retryableStatusCodes = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const maxAttempts = Math.max(1, Number($env.AI_DIRECT_API_MAX_ATTEMPTS || 2));
const baseDelayMs = Math.max(0, Number($env.AI_DIRECT_API_RETRY_BASE_MS || 2000));
const maxDelayMs = Math.max(baseDelayMs, Number($env.AI_DIRECT_API_RETRY_MAX_MS || 30000));
const cooldownMs = Math.max(1000, Number($env.AI_DIRECT_API_RATE_LIMIT_COOLDOWN_MS || 60000));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const safe = (value, fallback = '') => String(value ?? fallback).trim();
const baseUrl = safe(row.ai_base_url, 'https://generativelanguage.googleapis.com/v1beta/openai').replace(/\/+$/, '');
const path = safe(row.ai_request_path, '/responses');
const url = baseUrl + (path.startsWith('/') ? path : '/' + path);
const directApiKey = safe(row.ai_provider).toLowerCase() === 'openai'
  ? safe($env.OPENAI_API_KEY)
  : safe($env.AI_DIRECT_API_KEY);
const timeoutMs = Number(row.ai_timeout_ms || $env.AI_DIRECT_API_TIMEOUT_MS || 120000);
const workflowState = typeof $getWorkflowStaticData === 'function' ? $getWorkflowStaticData('global') : {};
const now = Date.now();

const headerValue = (headers, name) => {
  if (!headers || typeof headers !== 'object') return null;
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : null;
};
const parseRetryAfterMs = (headers) => {
  const value = headerValue(headers, 'retry-after');
  if (value === null || value === undefined || value === '') return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const timestamp = Date.parse(String(value));
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : null;
};
const retryDelay = (attempt, retryAfterMs) => {
  const exponential = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt - 1));
  const requested = Number.isFinite(retryAfterMs) ? Math.min(maxDelayMs, retryAfterMs) : 0;
  return Math.max(exponential, requested) + Math.floor(Math.random() * 250);
};
const publicHeaders = (headers) => ({
  retry_after: headerValue(headers, 'retry-after'),
  rate_limit_remaining: headerValue(headers, 'x-ratelimit-remaining'),
  rate_limit_reset: headerValue(headers, 'x-ratelimit-reset'),
});

if (Number(workflowState.aiRateLimitBlockedUntil || 0) > now) {
  return [{
    json: {
      ...row,
      ai_status_code: 429,
      ai_response: { status: 429, title: 'Rate limit cooldown active' },
      ai_response_headers: {},
      ai_retry_attempts: 0,
      ai_retry_exhausted: true,
      ai_retry_after_ms: Number(workflowState.aiRateLimitBlockedUntil) - now,
      ai_retry_last_error: 'rate_limit_cooldown',
      ai_circuit_open: true,
    },
  }];
}

let lastError = null;
let lastRetryAfterMs = null;

for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (directApiKey) headers.Authorization = 'Bearer ' + directApiKey;

    const response = await helpers.httpRequest({
      method: 'POST',
      url,
      headers,
      body: row.ai_request,
      json: true,
      returnFullResponse: true,
      ignoreHttpStatusErrors: true,
      timeout: timeoutMs,
    });

    const statusCode = Number(response.statusCode || 0);
    const responseHeaders = response.headers || {};
    lastRetryAfterMs = parseRetryAfterMs(responseHeaders);
    const shouldRetry = retryableStatusCodes.has(statusCode) && attempt < maxAttempts;
    if (!shouldRetry) {
      if (statusCode === 429) {
        workflowState.aiRateLimitBlockedUntil = Date.now() + Math.max(cooldownMs, lastRetryAfterMs || 0);
      } else if (statusCode >= 200 && statusCode < 300) {
        workflowState.aiRateLimitBlockedUntil = 0;
      }
      return [{
        json: {
          ...row,
          ai_status_code: statusCode,
          ai_response: response.body || {},
          ai_response_headers: publicHeaders(responseHeaders),
          ai_retry_attempts: attempt,
          ai_retry_exhausted: retryableStatusCodes.has(statusCode) && attempt >= maxAttempts,
          ai_retry_after_ms: lastRetryAfterMs,
          ai_retry_last_error: null,
          ai_circuit_open: statusCode === 429,
        },
      }];
    }
  } catch (error) {
    lastError = error;
    if (attempt >= maxAttempts) {
      return [{
        json: {
          ...row,
          ai_status_code: 0,
          ai_response: { error: { message: error.message } },
          ai_response_headers: {},
          ai_retry_attempts: attempt,
          ai_retry_exhausted: true,
          ai_retry_after_ms: null,
          ai_retry_last_error: error.message,
          ai_circuit_open: false,
        },
      }];
    }
  }

  await sleep(retryDelay(attempt, lastRetryAfterMs));
}

return [{
  json: {
    ...row,
    ai_status_code: 0,
    ai_response: { error: { message: lastError?.message || 'AI provider retry exhausted' } },
    ai_response_headers: {},
    ai_retry_attempts: maxAttempts,
    ai_retry_exhausted: true,
    ai_retry_after_ms: lastRetryAfterMs,
    ai_retry_last_error: lastError?.message || null,
    ai_circuit_open: false,
  },
}];
