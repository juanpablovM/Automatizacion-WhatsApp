#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"
node <<'NODE'
const fs = require('fs');
const workflow = JSON.parse(fs.readFileSync('n8n/workflows/crm-clickup-sync-lead.json', 'utf8'));
const node = (name) => workflow.nodes.find((entry) => entry.name === name);
const createCode = node('Create ClickUp Task').parameters.jsCode;
const commentCode = node('Create Conversation Comment If Present').parameters.jsCode;
const returnCode = node('Return ClickUp Sync Result').parameters.jsCode;
const loadQuery = node('Load ClickUp Context').parameters.query;
const persistQuery = node('Persist ClickUp Result').parameters.query;
const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
const fail = (message) => { throw new Error(message); };
const base = { should_create_clickup: true, clickup_task_url: 'https://api.clickup.test/task', clickup_task_payload: { name: 'Lead' } };
async function run(responses, row = base) {
  let calls = 0;
  const helpers = { httpRequest: async () => {
    const response = responses[Math.min(calls, responses.length - 1)]; calls += 1;
    if (response instanceof Error) throw response;
    return response;
  }};
  const fn = new AsyncFunction('items', '$env', 'helpers', createCode);
  const result = await fn([{ json: row }], {
    CLICKUP_API_TOKEN: 'test', EXTERNAL_HTTP_MAX_ATTEMPTS: '3',
    EXTERNAL_HTTP_RETRY_BASE_MS: '0', EXTERNAL_HTTP_RETRY_MAX_MS: '0',
  }, helpers);
  return { output: result[0].json, calls };
}
(async () => {
  const serverError = await run([{ statusCode: 500, body: { message: 'server error' } }]);
  if (serverError.calls !== 1 || serverError.output.operation_outcome !== 'unknown' || !serverError.output.reconciliation_required) fail('5xx ambiguo no debe repetir POST y debe quedar unknown');
  const timeout = await run([new Error('ETIMEDOUT')]);
  if (timeout.calls !== 1 || timeout.output.operation_outcome !== 'unknown' || !timeout.output.reconciliation_required) fail('Timeout no debe repetir POST y requiere reconciliacion');
  const runReturn = async (row) => {
    const fn = new AsyncFunction('items', '$env', returnCode);
    return fn([{ json: { lead_id: 42, ...row } }], {});
  };
  const returned500 = await runReturn(serverError.output);
  if (returned500.length !== 1 || returned500[0].json.operation_outcome !== 'unknown' || !returned500[0].json.reconciliation_required || returned500[0].json.clickup_task_id !== null) fail('Return debe emitir un item terminal para 5xx unknown sin task id');
  const returnedTimeout = await runReturn(timeout.output);
  if (returnedTimeout.length !== 1 || returnedTimeout[0].json.operation_outcome !== 'unknown' || !returnedTimeout[0].json.terminal_result_emitted) fail('Return debe emitir un item terminal para timeout unknown');
  const safe429 = await run([{ statusCode: 429, body: {} }, { statusCode: 201, body: { id: 'task-1' } }]);
  if (safe429.calls !== 2 || safe429.output.operation_outcome !== 'succeeded') fail('429 explicito debe ser el unico retry automatico habitual');
  const rejected = await run([{ statusCode: 400, body: { message: 'bad request' } }]);
  if (rejected.calls !== 1 || rejected.output.operation_outcome !== 'failed' || rejected.output.reconciliation_required) fail('4xx rechazado debe fallar sin reconciliacion');
  const returnedRejected = await runReturn(rejected.output);
  if (returnedRejected.length !== 1 || returnedRejected[0].json.operation_outcome !== 'failed' || returnedRejected[0].json.reconciliation_required) fail('Return debe emitir un item terminal para fallo seguro sin task id');
  const unknownReplay = await run([], { should_create_clickup: false, clickup_operation_status: 'unknown', clickup_reconciliation_required: true });
  if (unknownReplay.calls !== 0 || unknownReplay.output.operation_outcome !== 'unknown') fail('Operacion unknown nunca debe volver a ejecutar POST');
  const runComment = async (response) => {
    let calls = 0;
    const helpers = { httpRequest: async () => { calls += 1; if (response instanceof Error) throw response; return response; } };
    const fn = new AsyncFunction('items', '$env', 'helpers', commentCode);
    const result = await fn([{ json: { clickup_task_id: 'task-1', comment_enabled: true, idempotent_replay: false, comment_text: 'Conversation' } }], { CLICKUP_API_TOKEN: 'test' }, helpers);
    return { output: result[0].json, calls };
  };
  const ambiguousComment = await runComment({ statusCode: 503, body: { message: 'server error' } });
  if (ambiguousComment.calls !== 1 || ambiguousComment.output.conversation_comment_outcome !== 'unknown' || !ambiguousComment.output.conversation_comment_reconciliation_required) fail('Comentario 5xx debe hacer un solo POST y quedar unknown');
  const timeoutComment = await runComment(new Error('ETIMEDOUT'));
  if (timeoutComment.calls !== 1 || timeoutComment.output.conversation_comment_outcome !== 'unknown') fail('Comentario con timeout no debe reintentar POST');
  if (!loadQuery.includes("eo.status = 'failed' AND eo.retry_safe = TRUE") || loadQuery.includes("eo.status IN ('pending', 'failed')")) fail('Claim SQL solo debe reclamar fallos marcados retry_safe');
  if (!loadQuery.includes("SET status = 'unknown'") || !persistQuery.includes("WHEN $14::text = 'unknown' THEN 'unknown'")) fail('Workflow debe persistir y conservar outcome unknown');
  if (!persistQuery.includes('resolved_lead AS') || returnCode.includes('.filter(')) fail('Lane ClickUp debe conservar cardinalidad y no filtrar outcomes sin task id');
  const migration = fs.readFileSync('infra/postgres/migrations/007_add_delivery_integrity.sql', 'utf8');
  if (!migration.includes("'unknown'") || !migration.includes('reconciliation_required') || !migration.includes('retry_safe')) fail('Migration 007 debe soportar reconciliacion manual');
  console.log('ClickUp ambiguity local tests OK: no ambiguous POST retry, safe retry, unknown reconciliation');
})().catch((error) => { console.error(error.message); process.exit(1); });
NODE
