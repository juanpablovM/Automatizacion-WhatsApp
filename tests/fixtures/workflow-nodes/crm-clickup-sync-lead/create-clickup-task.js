const explicitlySafeRetryStatusCodes = new Set([425, 429]);
const maxAttempts = Number($env.EXTERNAL_HTTP_MAX_ATTEMPTS || 4);
const baseDelayMs = Number($env.EXTERNAL_HTTP_RETRY_BASE_MS || 1000);
const maxDelayMs = Number($env.EXTERNAL_HTTP_RETRY_MAX_MS || 10000);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const retryDelay = (attempt) => Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt - 1));
const normalizeBody = (value) => {
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch (_error) { return { raw: value }; }
  }
  return value || {};
};
const outcome = (statusCode, body, headers, attempt, operationOutcome, extra = {}) => ({
  statusCode, body: normalizeBody(body), headers: headers || {}, retry_attempts: attempt,
  retry_exhausted: Boolean(extra.retry_exhausted), retry_last_error: extra.retry_last_error || null,
  operation_outcome: operationOutcome,
  reconciliation_required: operationOutcome === 'unknown',
  retry_safe: Boolean(extra.retry_safe),
  idempotent_replay: Boolean(extra.idempotent_replay),
  idempotency_in_progress: Boolean(extra.idempotency_in_progress),
});

// Quote correction (owner decision 2026-10-14): Load ClickUp Context claimed
// this correction once (one operation per new requirement), so each write runs
// at most once per claim. The task update, the field values and the comment go
// in that order and stop at the first failure: the seller is only notified of a
// correction the task already shows. A lost response is unknown, never retried.
const applyCorrection = async (row) => {
  const taskUrl = String(row.clickup_update_url || '').trim();
  const headers = { Authorization: $env.CLICKUP_API_TOKEN, 'Content-Type': 'application/json' };
  const writes = [
    { method: 'PUT', url: taskUrl, body: row.clickup_update_payload || {} },
    ...(Array.isArray(row.clickup_update_custom_fields) ? row.clickup_update_custom_fields : [])
      .map((field) => ({ method: 'POST', url: taskUrl + '/field/' + encodeURIComponent(field.id), body: { value: field.value } })),
    { method: 'POST', url: taskUrl + '/comment', body: row.clickup_correction_comment || {} },
  ];
  if (!taskUrl) return { correction_outcome: 'failed', correction_error: 'missing clickup_update_url' };
  for (const write of writes) {
    let statusCode = 0;
    let responseBody = {};
    try {
      const response = await helpers.httpRequest({
        ...write, headers, json: true, returnFullResponse: true, ignoreHttpStatusErrors: true,
      });
      statusCode = Number(response.statusCode || 0);
      responseBody = response.body || {};
    } catch (error) {
      return { correction_outcome: 'unknown', correction_error: `${write.method} ${write.url}: ${error.message}` };
    }
    if (statusCode >= 200 && statusCode < 300) continue;
    const correctionOutcome = statusCode === 408 || statusCode >= 500 || statusCode === 0 ? 'unknown' : 'failed';
    return {
      correction_outcome: correctionOutcome,
      correction_error: `${write.method} ${write.url}: ${statusCode} ${JSON.stringify(normalizeBody(responseBody))}`,
    };
  }
  return { correction_outcome: 'succeeded', correction_error: null };
};

const row = items[0]?.json ?? {};
const shouldCreateClickup = Boolean(row.should_create_clickup);
const existingTaskId = String(row.existing_clickup_task_id || '').trim();
const operationStatus = String(row.clickup_operation_status || '').trim();
if (!shouldCreateClickup) {
  if (existingTaskId) {
    const replay = outcome(200, { id: existingTaskId, url: row.existing_clickup_task_url || null }, {}, 0, 'succeeded', { idempotent_replay: true });
    if (!row.should_update_clickup) return [{ json: replay }];
    return [{ json: { ...replay, ...(await applyCorrection(row)) } }];
  }
  if (operationStatus === 'unknown' || row.clickup_reconciliation_required) {
    return [{ json: outcome(0, { message: row.clickup_reconciliation_reason || 'Manual reconciliation required' }, {}, 0, 'unknown') }];
  }
  if (operationStatus === 'failed') {
    return [{ json: outcome(0, { message: 'ClickUp operation failed and is not safe to retry automatically' }, {}, 0, 'failed') }];
  }
  return [{ json: outcome(202, {}, {}, 0, 'in_progress', { idempotency_in_progress: true }) }];
}
const url = String(row.clickup_task_url || '').trim();
const body = row.clickup_task_payload;
if (!url) throw new Error('Create ClickUp Task requiere clickup_task_url');
if (!body) throw new Error('Create ClickUp Task requiere clickup_task_payload');

for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
  try {
    const response = await helpers.httpRequest({
      method: 'POST', url,
      headers: { Authorization: $env.CLICKUP_API_TOKEN, 'Content-Type': 'application/json' },
      body, json: true, returnFullResponse: true, ignoreHttpStatusErrors: true,
    });
    const statusCode = Number(response.statusCode || 0);
    if (statusCode >= 200 && statusCode < 300) {
      return [{ json: outcome(statusCode, response.body, response.headers, attempt, 'succeeded') }];
    }
    if (explicitlySafeRetryStatusCodes.has(statusCode)) {
      if (attempt < maxAttempts) { await sleep(retryDelay(attempt)); continue; }
      return [{ json: outcome(statusCode, response.body, response.headers, attempt, 'failed', { retry_exhausted: true, retry_safe: true }) }];
    }
    // 408 and every 5xx are ambiguous for a non-idempotent POST: ClickUp may
    // have created the task before the response was lost. Never POST again.
    if (statusCode === 408 || statusCode >= 500 || statusCode === 0) {
      return [{ json: outcome(statusCode, response.body, response.headers, attempt, 'unknown') }];
    }
    return [{ json: outcome(statusCode, response.body, response.headers, attempt, 'failed') }];
  } catch (error) {
    // A transport timeout/error does not prove the POST was rejected.
    return [{ json: outcome(0, { message: error.message }, {}, attempt, 'unknown', { retry_last_error: error.message }) }];
  }
}
return [{ json: outcome(0, { message: 'Unexpected ClickUp execution state' }, {}, maxAttempts, 'unknown') }];