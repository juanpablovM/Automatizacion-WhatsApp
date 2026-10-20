const row = items[0]?.json ?? {};

const statusCode = Number(row.statusCode_2 || row.statusCode || 0);
const responseBody = row.body_2 || row.body || {};
const retryAttempts = Number(row.retry_attempts_2 || row.retry_attempts || 1);
const retryExhausted = Boolean(row.retry_exhausted_2 || row.retry_exhausted || false);
const retryLastError = row.retry_last_error_2 || row.retry_last_error || null;
const idempotentReplay = Boolean(row.idempotent_replay_2 || row.idempotent_replay || false);
const operationOutcome = String(row.operation_outcome_2 || row.operation_outcome || '').trim() || 'failed';
const reconciliationRequired = Boolean(row.reconciliation_required_2 || row.reconciliation_required || operationOutcome === 'unknown');
const retrySafe = Boolean(row.retry_safe_2 || row.retry_safe || false);
const idempotencyInProgress = Boolean(row.idempotency_in_progress_2 || row.idempotency_in_progress || false);
const isSuccess = statusCode >= 200 && statusCode < 300 && !!responseBody?.id;
const taskId = isSuccess ? String(responseBody.id) : null;
// Quote correction: the claimed correction's outcome, and the requirement the
// task now shows when it succeeded (Persist ClickUp Result stores it on the
// lead, so a failed correction is never mistaken for a synced one).
const correctionOperationKey = String(row.clickup_correction_operation_key || '').trim();
const correctionOutcome = correctionOperationKey
  ? String(row.correction_outcome_2 || row.correction_outcome || '').trim() || 'unknown'
  : '';
const correctedRequirement = correctionOutcome === 'succeeded'
  ? String(row.clickup_correction_requirement ?? '')
  : '';
const taskUrl = isSuccess ? String(responseBody.url || `https://app.clickup.com/t/${responseBody.id}`) : null;

return [
  {
    json: {
      lead_id: row.lead_id_1 || row.lead_id,
      clickup_operation_key: row.clickup_operation_key_1 || row.clickup_operation_key || null,
      idempotent_replay: idempotentReplay,
      idempotency_in_progress: idempotencyInProgress,
      clickup_task_id: taskId,
      clickup_task_url: taskUrl,
      is_success: isSuccess,
      event_name: 'clickup_task_sync',
      result: isSuccess ? 'success' : operationOutcome === 'unknown' ? 'unknown' : 'error',
      operation_outcome: isSuccess ? 'succeeded' : operationOutcome,
      reconciliation_required: reconciliationRequired,
      retry_safe: retrySafe,
      comment_enabled: Boolean(row.comment_enabled_1 || row.comment_enabled),
      comment_text: row.comment_text_1 || row.comment_text || '',
      clickup_correction_operation_key: correctionOperationKey,
      clickup_correction_outcome: correctionOutcome,
      clickup_correction_error: row.correction_error_2 || row.correction_error || null,
      clickup_synced_requirement: correctedRequirement,
      after_payload_json: JSON.stringify({
        status_code: statusCode,
        response_body: responseBody,
        retry_attempts: retryAttempts,
        retry_exhausted: retryExhausted,
        operation_outcome: isSuccess ? 'succeeded' : operationOutcome,
        reconciliation_required: reconciliationRequired,
        retry_safe: retrySafe,
        retry_last_error: retryLastError,
      }),
      metadata_json: JSON.stringify({
        task_name: row.task_name_1 || row.task_name || null,
        attachments_count: Array.isArray(row.attachments_json_1) ? row.attachments_json_1.length : 0,
        provider: 'clickup',
        retry_attempts: retryAttempts,
        retry_exhausted: retryExhausted,
        operation_outcome: isSuccess ? 'succeeded' : operationOutcome,
        reconciliation_required: reconciliationRequired,
        retry_safe: retrySafe,
        ...(correctionOperationKey ? {
          correction_operation_key: correctionOperationKey,
          correction_outcome: correctionOutcome,
          correction_error: row.correction_error_2 || row.correction_error || null,
        } : {}),
      }),
    },
  },
];