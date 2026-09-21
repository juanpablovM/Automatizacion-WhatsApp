// =============================================================================
// OPS - Lead Chat Lease Scheduler — Dispatch Lead Chat Restoration
// -----------------------------------------------------------------------------
// Puts the ClickUp task back where the salesperson found it, after the SLA
// expired and 06_claim_expired_ownerships.sql already freed the AI.
//
// The order is the whole point. PostgreSQL released the lease inside the claim
// transaction, so by the time this node runs the bot is answering again. ClickUp
// is a downstream projection: nothing here can block that release, reverse it,
// or re-suppress the AI, and the output carries no field that could. A total
// ClickUp outage costs an unrestored task status, never a muted bot.
//
// GET before write, always. This is the repo's first PUT /api/v2/task/{id}, and
// a blind write would race a human. The read decides between three outcomes:
//   - the task already sits at previous_clickup_status: nothing to do, the
//     restoration is reconciled and reported 'succeeded' with no write at all
//   - the task is still in the acquisition status (CLICKUP_STATUS_ACKNOWLEDGED,
//     'in progress' by default): restore it with the captured status verbatim,
//     casing included, because ClickUp status names are user-editable labels
//   - the task is anywhere else: a human moved it after the evidence was
//     captured. Report 'skipped_status_changed' with what was observed and
//     never overwrite that decision. Restoring here would silently undo it.
//
// An ambiguous PUT (timeout, 5xx, empty 2xx body) is reconciled by ONE follow-up
// GET, never a blind re-PUT: the write may well have landed, and repeating it
// could overwrite a status a human set in between. If the reconciliation GET
// does not positively confirm the previous status, the outcome is 'unknown' and
// the claim is deliberately left open — 06's stale branch re-claims it after
// $2 seconds with a fresh token and starts again from a fresh GET, which is
// exactly the follow-up-read-before-retry rule stated once more at the DB level.
//
// Outcome vocabulary mirrors dispatch-handoff-clickup-task.js:
//   succeeded | failed | unknown | deferred, plus skipped_status_changed.
// Their projection onto $3 of 07_complete_restoration.sql:
//   succeeded              -> 'succeeded'
//   skipped_status_changed -> 'skipped_status_changed'
//   failed | deferred      -> 'failed'
//   unknown                -> no completion at all (should_complete = false)
//
// 'deferred' closes as 'failed' on purpose. A configuration gap that hands the
// attempt back forever is indistinguishable from a healthy queue — the exact
// pathology 03_complete_notification.sql documents with 5223 silent deferral
// rows. Here the missing variable is named in restoration_error and in
// external_operations.last_error, where an operator can actually see it, at the
// cost of needing a manual reset once the token is configured.
//
// Output (always exactly one item, superset of the prepared row):
//   { restoration_outcome, restoration_status_code, restoration_retry_safe,
//     restoration_error, observed_clickup_status, restoration_response_json,
//     restoration_result, should_complete, completion_ownership_id }
// =============================================================================

// A placeholder is not a value. Calling ClickUp with '__PENDIENTE__' burns an
// attempt to learn something the environment already knows.
const configured = (value) => Boolean(value) && !String(value).includes('__PENDIENTE__');

const DEFAULT_ACQUISITION_STATUSES = 'in progress,en progreso,en curso';

const parseStatusList = (raw, fallback) => String(raw || fallback)
  .split(',')
  .map((entry) => entry.trim().toLowerCase())
  .filter(Boolean);

const normalizedBody = (value) => {
  if (value === null || value === undefined) return {};
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch (_error) { return { raw: value }; }
};

// ClickUp returns the status as an object on the task, but a bare string shows
// up in trimmed payloads. Reading both keeps a shape change from looking like a
// status change, which would wrongly report skipped_status_changed.
const observedStatusOf = (body) => {
  const status = body && typeof body === 'object' ? body.status : null;
  if (status && typeof status === 'object') return String(status.status ?? '').trim();
  return String(status ?? '').trim();
};

const sameStatus = (left, right) => {
  const a = String(left ?? '').trim().toLowerCase();
  const b = String(right ?? '').trim().toLowerCase();
  return Boolean(a) && a === b;
};

// How each outcome projects onto 07_complete_restoration.sql. 'unknown' has no
// row here: it must not close a claim it could not prove anything about.
const COMPLETION_BY_OUTCOME = {
  succeeded: { result: 'succeeded', complete: true },
  skipped_status_changed: { result: 'skipped_status_changed', complete: true },
  failed: { result: 'failed', complete: true },
  deferred: { result: 'failed', complete: true },
  unknown: { result: null, complete: false },
  skipped_no_previous_status: { result: null, complete: false },
};

const result = (row, outcome, statusCode, body, options = {}) => {
  const projection = COMPLETION_BY_OUTCOME[outcome] || { result: null, complete: false };
  return {
    ...row,
    restoration_outcome: outcome,
    restoration_status_code: statusCode,
    restoration_retry_safe: Boolean(options.retrySafe),
    restoration_error: options.error || null,
    observed_clickup_status: options.observedStatus || null,
    restoration_response_json: JSON.stringify(normalizedBody(body)),
    restoration_result: projection.result,
    should_complete: projection.complete,
    // A skipped or unconfirmed row reaches the completion node with a NULL
    // ownership id, which 07 answers 'unknown_ownership' without writing.
    completion_ownership_id: projection.complete ? row.ownership_id : null,
  };
};

const clickupCall = async (httpRequest, apiToken, options) => {
  const response = await httpRequest({
    json: true,
    returnFullResponse: true,
    ignoreHttpStatusErrors: true,
    timeout: 30000,
    ...options,
    headers: { Authorization: apiToken, ...(options.headers || {}) },
  });
  const statusCode = Number(response?.statusCode || 0);
  const body = normalizedBody(response?.body);
  return {
    statusCode,
    body,
    ok: statusCode >= 200 && statusCode < 300,
    // 425/429 say "the write did not happen, come back later": deterministic
    // and safe to repeat. 0/408/5xx say nothing at all.
    retrySafe: statusCode === 425 || statusCode === 429,
    ambiguous: statusCode === 0 || statusCode === 408 || statusCode >= 500,
    empty: !body || typeof body !== 'object' || Object.keys(body).length === 0,
  };
};

const readTask = (httpRequest, apiToken, taskUrl) =>
  clickupCall(httpRequest, apiToken, { method: 'GET', url: taskUrl });

const writeStatus = (httpRequest, apiToken, taskUrl, previousStatus) =>
  clickupCall(httpRequest, apiToken, {
    method: 'PUT',
    url: taskUrl,
    headers: { 'Content-Type': 'application/json' },
    // Verbatim: the captured label is the only evidence of where the task was,
    // and normalizing its casing would invent a status ClickUp may not have.
    body: { status: previousStatus },
  });

const failureOf = (row, call, stage, observedStatus) => {
  if (call.retrySafe) {
    return result(row, 'failed', call.statusCode, call.body, {
      error: `${stage}_retryable_http_${call.statusCode}`,
      retrySafe: true,
      observedStatus,
    });
  }
  if (call.ambiguous) {
    return result(row, 'unknown', call.statusCode, call.body, {
      error: `${stage}_ambiguous_http_${call.statusCode}`,
      observedStatus,
    });
  }
  return result(row, 'failed', call.statusCode, call.body, {
    error: `${stage}_http_${call.statusCode}`,
    observedStatus,
  });
};

// One follow-up read after an ambiguous write. Never a second PUT.
const reconcileAfterWrite = async (row, httpRequest, apiToken, taskUrl, previousStatus, write) => {
  const after = await readTask(httpRequest, apiToken, taskUrl);
  if (!after.ok) {
    return result(row, 'unknown', write.statusCode, after.body, {
      error: `clickup_restore_unconfirmed_http_${write.statusCode}`,
    });
  }
  const observed = observedStatusOf(after.body);
  if (sameStatus(observed, previousStatus)) {
    return result(row, 'succeeded', after.statusCode, after.body, { observedStatus: observed });
  }
  // The write is neither proven applied nor proven lost. Leaving the claim open
  // hands it to 06's stale branch, which starts over from a fresh read.
  return result(row, 'unknown', write.statusCode, after.body, {
    error: `clickup_restore_unconfirmed_http_${write.statusCode}:${observed || 'unknown'}`,
    observedStatus: observed || null,
  });
};

const dispatchLeadChatRestoration = async (row, httpRequest, env = {}) => {
  // Terminal at claim time, or missing the identity a completion needs. 06
  // already wrote the visible evidence; guessing a status is worse than the gap.
  if (String(row.restoration_state ?? '') === 'skipped_no_previous_status'
    || row.should_dispatch_restoration === false) {
    return result(row, 'skipped_no_previous_status', 0, {}, {
      error: row.restoration_config_error || 'restoration_not_dispatchable',
    });
  }

  const apiToken = env.CLICKUP_API_TOKEN;
  if (!configured(apiToken)) {
    return result(row, 'deferred', 0, {}, { error: 'CLICKUP_API_TOKEN_missing' });
  }

  const previousStatus = String(row.previous_clickup_status ?? '').trim();
  const clickupTaskId = String(row.clickup_task_id ?? '').trim();
  if (!previousStatus || !clickupTaskId) {
    return result(row, 'skipped_no_previous_status', 0, {}, {
      error: previousStatus ? 'clickup_task_id_missing' : 'previous_clickup_status_missing',
    });
  }

  const taskUrl = row.clickup_task_url
    || `https://api.clickup.com/api/v2/task/${encodeURIComponent(clickupTaskId)}`;
  const acquisitionStatuses = parseStatusList(
    env.CLICKUP_STATUS_ACKNOWLEDGED, DEFAULT_ACQUISITION_STATUSES,
  );

  try {
    const before = await readTask(httpRequest, apiToken, taskUrl);
    if (!before.ok) return failureOf(row, before, 'clickup_task_read', null);

    const observed = observedStatusOf(before.body);

    // Already reconciled: someone or something already put it back. Reporting
    // success without a write is the honest answer, and the cheapest.
    if (sameStatus(observed, previousStatus)) {
      return result(row, 'succeeded', before.statusCode, before.body, {
        observedStatus: observed,
      });
    }

    // Anywhere other than the acquisition status means a human moved the task
    // after the evidence was captured. That decision outranks this restoration.
    if (!acquisitionStatuses.includes(observed.toLowerCase())) {
      return result(row, 'skipped_status_changed', before.statusCode, before.body, {
        error: `clickup_status_changed:${observed || 'unknown'}`,
        observedStatus: observed || null,
      });
    }

    const write = await writeStatus(httpRequest, apiToken, taskUrl, previousStatus);
    if (write.ok && !write.empty) {
      return result(row, 'succeeded', write.statusCode, write.body, {
        observedStatus: observedStatusOf(write.body) || previousStatus,
      });
    }
    if (write.retrySafe) {
      return result(row, 'failed', write.statusCode, write.body, {
        error: `clickup_restore_retryable_http_${write.statusCode}`,
        retrySafe: true,
        observedStatus: observed,
      });
    }
    if (write.ambiguous || write.ok) {
      // Ambiguous, including a 2xx that proved nothing: read, do not re-write.
      return reconcileAfterWrite(row, httpRequest, apiToken, taskUrl, previousStatus, write);
    }
    return result(row, 'failed', write.statusCode, write.body, {
      error: `clickup_restore_http_${write.statusCode}`,
      observedStatus: observed,
    });
  } catch (error) {
    return result(row, 'unknown', 0, {}, {
      error: String(error?.message || 'clickup_transport_error'),
    });
  }
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    configured,
    parseStatusList,
    normalizedBody,
    observedStatusOf,
    sameStatus,
    dispatchLeadChatRestoration,
  };
}

if (typeof $json !== 'undefined') {
  return dispatchLeadChatRestoration(
    $json ?? {},
    helpers.httpRequest.bind(helpers),
    typeof $env !== 'undefined' ? $env : {},
  ).then((output) => ({ json: output }));
}
