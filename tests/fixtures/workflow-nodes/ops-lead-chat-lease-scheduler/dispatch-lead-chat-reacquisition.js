// =============================================================================
// OPS - Lead Chat Lease Scheduler — Dispatch Lead Chat Reacquisition
// -----------------------------------------------------------------------------
// Projects a late human reply back to ClickUp. PostgreSQL has already restored
// local human ownership; this node only makes ClickUp converge to that state.
// Every attempt reads first. An ambiguous PUT is followed by one GET and never
// by a second PUT, so recovery can prove an earlier write without guessing.
// =============================================================================

const configured = (value) => Boolean(value) && !String(value).includes('__PENDIENTE__');

const normalizedBody = (value) => {
  if (value === null || value === undefined) return {};
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch (_error) { return { raw: value }; }
};

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

const outputOf = (row, outcome, statusCode, body, options = {}) => ({
  ...row,
  reacquisition_result: outcome,
  reacquisition_status_code: Number(statusCode || 0),
  reacquisition_error: options.error || null,
  observed_clickup_status: options.observedStatus || null,
  reacquisition_response_json: JSON.stringify(normalizedBody(body)),
});

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
    retrySafe: statusCode === 425 || statusCode === 429,
    ambiguous: statusCode === 0 || statusCode === 408 || statusCode >= 500,
  };
};

const classifyFailure = (row, call, stage, observedStatus = null) => {
  if (call.retrySafe) {
    return outputOf(row, 'retry', call.statusCode, call.body, {
      error: `${stage}_retryable_http_${call.statusCode}`,
      observedStatus,
    });
  }
  if (call.ambiguous) {
    return outputOf(row, 'unknown', call.statusCode, call.body, {
      error: `${stage}_ambiguous_http_${call.statusCode}`,
      observedStatus,
    });
  }
  return outputOf(row, 'failed', call.statusCode, call.body, {
    error: `${stage}_http_${call.statusCode}`,
    observedStatus,
  });
};

const dispatchLeadChatReacquisition = async (row, httpRequest, env = {}) => {
  if (row.should_dispatch_reacquisition === false) {
    return outputOf(row, 'skipped_ownership_changed', 0, {}, {
      error: row.reacquisition_blocker || 'ownership_not_active',
    });
  }

  const apiToken = env.CLICKUP_API_TOKEN;
  if (!configured(apiToken)) {
    return outputOf(row, 'failed', 0, {}, { error: 'CLICKUP_API_TOKEN_missing' });
  }

  const taskId = String(row.clickup_task_id ?? '').trim();
  const targetStatus = String(row.target_status ?? '').trim();
  if (!taskId || !targetStatus) {
    return outputOf(row, 'failed', 0, {}, {
      error: taskId ? 'target_status_missing' : 'clickup_task_id_missing',
    });
  }

  const taskUrl = row.clickup_task_url
    || `https://api.clickup.com/api/v2/task/${encodeURIComponent(taskId)}`;
  const readTask = () => clickupCall(httpRequest, apiToken, { method: 'GET', url: taskUrl });

  try {
    const before = await readTask();
    if (!before.ok) return classifyFailure(row, before, 'clickup_task_read');

    const observedBefore = observedStatusOf(before.body);
    if (sameStatus(observedBefore, targetStatus)) {
      return outputOf(row, 'succeeded', before.statusCode, before.body, {
        observedStatus: observedBefore,
      });
    }

    const write = await clickupCall(httpRequest, apiToken, {
      method: 'PUT',
      url: taskUrl,
      headers: { 'Content-Type': 'application/json' },
      body: { status: targetStatus },
    });

    const observedWrite = observedStatusOf(write.body);
    if (write.ok && sameStatus(observedWrite, targetStatus)) {
      return outputOf(row, 'succeeded', write.statusCode, write.body, {
        observedStatus: observedWrite,
      });
    }
    if (write.retrySafe) {
      return classifyFailure(row, write, 'clickup_reacquire_write', observedBefore);
    }
    if (!write.ok && !write.ambiguous) {
      return classifyFailure(row, write, 'clickup_reacquire_write', observedBefore);
    }

    // Empty 2xx, timeout and 5xx do not prove whether the PUT landed.
    const after = await readTask();
    if (!after.ok) {
      return outputOf(row, 'unknown', write.statusCode, after.body, {
        error: `clickup_reacquire_unconfirmed_http_${write.statusCode}`,
        observedStatus: observedBefore || null,
      });
    }
    const observedAfter = observedStatusOf(after.body);
    if (sameStatus(observedAfter, targetStatus)) {
      return outputOf(row, 'succeeded', after.statusCode, after.body, {
        observedStatus: observedAfter,
      });
    }
    return outputOf(row, 'unknown', write.statusCode, after.body, {
      error: `clickup_reacquire_unconfirmed_http_${write.statusCode}:${observedAfter || 'unknown'}`,
      observedStatus: observedAfter || null,
    });
  } catch (error) {
    return outputOf(row, 'unknown', 0, {}, {
      error: String(error?.message || 'clickup_transport_error'),
    });
  }
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    configured,
    normalizedBody,
    observedStatusOf,
    sameStatus,
    dispatchLeadChatReacquisition,
  };
}

if (typeof $json !== 'undefined') {
  return dispatchLeadChatReacquisition(
    $json ?? {},
    helpers.httpRequest.bind(helpers),
    typeof $env !== 'undefined' ? $env : {},
  ).then((output) => ({ json: output }));
}
