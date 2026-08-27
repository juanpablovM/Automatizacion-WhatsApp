const normalizedBody = (value) => {
  if (typeof value !== 'string') return value || {};
  try { return JSON.parse(value); } catch (_error) { return { raw: value }; }
};

const result = (row, outcome, statusCode, body, options = {}) => ({
  ...row,
  notification_outcome: outcome,
  notification_status_code: statusCode,
  notification_external_id: options.externalId || null,
  notification_external_url: options.externalUrl || null,
  notification_error: options.error || null,
  notification_retry_safe: Boolean(options.retrySafe),
  notification_response_json: JSON.stringify(normalizedBody(body)),
});

const reconcileExactMarker = (tasks, operationKey) => {
  const matches = tasks.filter((task) => String(task.description || '').includes(`Operation key: ${operationKey}`));
  return matches.length === 1
    ? { outcome: 'succeeded', match: matches[0] }
    : matches.length > 1 ? { outcome: 'duplicate_incident' } : { outcome: 'reconciliation_required' };
};

const searchExactMarker = async (row, httpRequest, apiToken) => {
  const operationKey = String(row.operation_key || '').trim();
  const listId = String(row.clickup_list_id || '').trim() || String(row.clickup_url || '').match(/\/list\/([^/]+)\/task$/)?.[1];
  if (!operationKey || !listId) throw new Error('clickup_reconciliation_identity_missing');
  const tasks = [];
  for (const archived of [false, true]) {
    for (let page = 0; page < 20; page += 1) {
      const response = await httpRequest({
        method: 'GET',
        url: `https://api.clickup.com/api/v2/list/${encodeURIComponent(listId)}/task?include_closed=true&archived=${archived}&page=${page}`,
        headers: { Authorization: apiToken },
        json: true,
        returnFullResponse: true,
        ignoreHttpStatusErrors: true,
        timeout: 30000,
      });
      const statusCode = Number(response?.statusCode || 0);
      if (statusCode < 200 || statusCode >= 300) throw new Error(`clickup_reconciliation_http_${statusCode}`);
      const body = normalizedBody(response?.body);
      tasks.push(...(Array.isArray(body.tasks) ? body.tasks : []));
      if (body.last_page === true) break;
    }
  }
  return reconcileExactMarker(tasks, operationKey);
};

const dispatchHandoffClickup = async (row, httpRequest, apiToken) => {
  if (!row.should_dispatch_clickup) {
    return result(row, 'deferred', 0, {}, {
      error: row.clickup_config_error || 'clickup_configuration_missing',
      retrySafe: false,
    });
  }

  try {
    if (row.reconciliation_required) {
      const reconciliation = await searchExactMarker(row, httpRequest, apiToken);
      if (reconciliation.outcome === 'succeeded') {
        if (!reconciliation.match?.id) {
          return result(row, 'unknown', 0, reconciliation.match || {}, { error: 'clickup_reconciliation_match_missing_task_id' });
        }
        return result(row, 'succeeded', 200, reconciliation.match, {
          externalId: String(reconciliation.match.id),
          externalUrl: reconciliation.match.url ? String(reconciliation.match.url) : null,
        });
      }
      if (reconciliation.outcome === 'duplicate_incident') {
        return result(row, 'failed', 409, {}, { error: 'clickup_reconciliation_duplicate_marker' });
      }
      if (!row.no_effect_authorization_consumed) {
        return result(row, 'unknown', 0, {}, { error: 'clickup_reconciliation_authorization_required' });
      }
    }
    const response = await httpRequest({
      method: 'POST',
      url: row.clickup_url,
      headers: { Authorization: apiToken, 'Content-Type': 'application/json' },
      body: row.clickup_payload,
      json: true,
      returnFullResponse: true,
      ignoreHttpStatusErrors: true,
      timeout: 30000,
    });
    const statusCode = Number(response?.statusCode || 0);
    const body = normalizedBody(response?.body);
    if (statusCode >= 200 && statusCode < 300) {
      if (!body.id) {
        return result(row, 'unknown', statusCode, body, {
          error: 'clickup_success_missing_task_id',
          retrySafe: false,
        });
      }
      return result(row, 'succeeded', statusCode, body, {
        externalId: body.id ? String(body.id) : null,
        externalUrl: body.url ? String(body.url) : null,
      });
    }
    if (statusCode === 425 || statusCode === 429) {
      return result(row, 'failed', statusCode, body, {
        error: `clickup_retryable_http_${statusCode}`,
        retrySafe: true,
      });
    }
    if (statusCode === 0 || statusCode === 408 || statusCode >= 500) {
      return result(row, 'unknown', statusCode, body, {
        error: `clickup_ambiguous_http_${statusCode}`,
        retrySafe: false,
      });
    }
    return result(row, 'failed', statusCode, body, {
      error: `clickup_http_${statusCode}`,
      retrySafe: false,
    });
  } catch (error) {
    return result(row, 'unknown', 0, {}, {
      error: String(error?.message || 'clickup_transport_error'),
      retrySafe: false,
    });
  }
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { normalizedBody, reconcileExactMarker, searchExactMarker, dispatchHandoffClickup };
}

if (typeof $json !== 'undefined') {
  return dispatchHandoffClickup($json ?? {}, helpers.httpRequest.bind(helpers), $env.CLICKUP_API_TOKEN)
    .then((output) => ({ json: output }));
}
