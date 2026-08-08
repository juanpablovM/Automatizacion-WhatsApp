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

const dispatchHandoffClickup = async (row, httpRequest, apiToken) => {
  if (!row.should_dispatch_clickup) {
    return result(row, 'deferred', 0, {}, {
      error: row.clickup_config_error || 'clickup_configuration_missing',
      retrySafe: false,
    });
  }

  try {
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
  module.exports = { normalizedBody, dispatchHandoffClickup };
}

if (typeof items !== 'undefined') {
  return dispatchHandoffClickup(items[0]?.json ?? {}, helpers.httpRequest.bind(helpers), $env.CLICKUP_API_TOKEN)
    .then((output) => [{ json: output }]);
}
