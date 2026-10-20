// =============================================================================
// Quote correction (owner decision 2026-10-14): a re-confirmed reopened quote
// updates its existing ClickUp task instead of creating a second one. Load
// ClickUp Context claims one correction per new requirement; Build ClickUp
// Payload prepares the description, the "🔍 Solicitud" and "Tipo de producto"
// fields and a comment for the assigned seller; Create ClickUp Task applies
// them; Normalize ClickUp Result reports what the task now shows.
// =============================================================================
import fs from 'node:fs';
import { describe, expect, test, vi } from 'vitest';

const root = 'tests/fixtures/workflow-nodes/crm-clickup-sync-lead/';
const source = (file) => fs.readFileSync(root + file, 'utf8');
const runNode = (file, row, env = {}) => new Function('items', '$env', source(file))([{ json: row }], env)[0].json;
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const runAsyncNode = async (file, row, env, helpers) => (
  await new AsyncFunction('items', '$env', 'helpers', source(file))([{ json: row }], env, helpers)
)[0].json;

const env = {
  CLICKUP_LEADS_LIST_ID: 'list-901',
  CLICKUP_API_TOKEN: 'synthetic-token',
  CLICKUP_CF_REQUIREMENT_ID: 'cf-requirement',
  CLICKUP_CF_CITY_ID: 'cf-city',
  CLICKUP_CF_PRODUCT_TYPE_ID: 'cf-product-type',
  CLICKUP_CF_PRODUCT_TYPE_OPTIONS_JSON: JSON.stringify({ Bloques: 'opt-bloques', Soleras: 'opt-soleras', Adoquines: 'opt-adoquines' }),
  CLICKUP_CF_CONSULTATION_DATE_ID: 'cf-date',
  EXTERNAL_HTTP_MAX_ATTEMPTS: '1',
};
const correctionRow = () => ({
  lead_id: 402,
  should_create_clickup: false,
  should_update_clickup: true,
  existing_clickup_task_id: '86e3qf426',
  existing_clickup_task_url: 'https://app.clickup.com/t/86e3qf426',
  clickup_operation_key: 'clickup-task:lead:402',
  clickup_correction_operation_key: 'clickup-task-correction:lead:402:abc',
  clickup_requirement_before: '• 50 bloques',
  whatsapp_name: 'Cliente', service: 'despacho', city: 'Maipú', requirement: '• 80 bloques\n• 20 soleras',
  phone_number: '56900000496', channel: 'whatsapp', source_number_id: 1,
  qualification_context: { line_items: [{ product: 'Bloques', quantity: '80' }, { product: 'Soleras', quantity: '20' }] },
  clickup_user_id: '101',
});

describe('Build ClickUp Payload — correction of an existing task', () => {
  test('prepares the task update, the two corrected fields and the seller comment', () => {
    const out = runNode('build-clickup-payload.js', correctionRow(), env);
    expect(out.should_update_clickup).toBe(true);
    expect(out.clickup_correction_operation_key).toBe('clickup-task-correction:lead:402:abc');
    expect(out.clickup_correction_requirement).toBe('• 80 bloques\n• 20 soleras');
    expect(out.clickup_update_url).toBe('https://api.clickup.com/api/v2/task/86e3qf426');
    expect(Object.keys(out.clickup_update_payload)).toEqual(['description']);
    expect(out.clickup_update_payload.description).toContain('Requerimiento: • 80 bloques\n• 20 soleras');
    expect(out.clickup_update_payload.description).toBe(out.clickup_task_payload.description);
    expect(out.clickup_update_custom_fields).toEqual([
      { id: 'cf-requirement', value: '• 80 bloques\n• 20 soleras' },
      { id: 'cf-product-type', value: ['opt-bloques', 'opt-soleras'] },
    ]);
    expect(out.clickup_correction_comment).toEqual({
      comment_text: '✏️ Corrección del cliente: • 50 bloques → • 80 bloques; • 20 soleras',
      assignee: 101,
      notify_all: false,
    });
  });

  test('a row that is not a correction carries no correction fields', () => {
    const out = runNode('build-clickup-payload.js', { ...correctionRow(), should_update_clickup: false }, env);
    expect(out).not.toHaveProperty('should_update_clickup');
    expect(out).not.toHaveProperty('clickup_update_payload');
  });
});

const respond = (statusCode, body = {}) => ({ statusCode, body, headers: {} });

describe('Create ClickUp Task — correction of an existing task', () => {
  const built = () => runNode('build-clickup-payload.js', correctionRow(), env);

  test('updates the description and fields, then comments for the seller, and never creates a task', async () => {
    const httpRequest = vi.fn().mockResolvedValue(respond(200, { id: 'ok' }));
    const out = await runAsyncNode('create-clickup-task.js', built(), env, { httpRequest });
    expect(httpRequest.mock.calls.map(([request]) => `${request.method} ${request.url}`)).toEqual([
      'PUT https://api.clickup.com/api/v2/task/86e3qf426',
      'POST https://api.clickup.com/api/v2/task/86e3qf426/field/cf-requirement',
      'POST https://api.clickup.com/api/v2/task/86e3qf426/field/cf-product-type',
      'POST https://api.clickup.com/api/v2/task/86e3qf426/comment',
    ]);
    expect(httpRequest.mock.calls[0][0].body).toEqual(built().clickup_update_payload);
    expect(httpRequest.mock.calls[2][0].body).toEqual({ value: ['opt-bloques', 'opt-soleras'] });
    expect(httpRequest.mock.calls[3][0].body).toEqual(built().clickup_correction_comment);
    expect(out).toMatchObject({
      statusCode: 200, body: { id: '86e3qf426' }, operation_outcome: 'succeeded', idempotent_replay: true,
      correction_outcome: 'succeeded',
    });
  });

  test('a rejected update stops before the comment and reports the correction failed', async () => {
    const httpRequest = vi.fn().mockResolvedValue(respond(400, { err: 'bad' }));
    const out = await runAsyncNode('create-clickup-task.js', built(), env, { httpRequest });
    expect(httpRequest).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ operation_outcome: 'succeeded', idempotent_replay: true, correction_outcome: 'failed' });
    expect(out.correction_error).toContain('400');
  });

  test('a lost response leaves the correction unknown', async () => {
    const httpRequest = vi.fn()
      .mockResolvedValueOnce(respond(200))
      .mockRejectedValueOnce(new Error('socket hang up'));
    const out = await runAsyncNode('create-clickup-task.js', built(), env, { httpRequest });
    expect(out.correction_outcome).toBe('unknown');
    expect(out.correction_error).toContain('socket hang up');
  });

  test('an existing task without a correction stays a plain replay', async () => {
    const httpRequest = vi.fn();
    const row = runNode('build-clickup-payload.js', { ...correctionRow(), should_update_clickup: false }, env);
    const out = await runAsyncNode('create-clickup-task.js', row, env, { httpRequest });
    expect(httpRequest).not.toHaveBeenCalled();
    expect(out).toMatchObject({ idempotent_replay: true, operation_outcome: 'succeeded' });
    expect(out).not.toHaveProperty('correction_outcome');
  });
});

describe('Normalize ClickUp Result — correction outcome', () => {
  const merged = (correctionOutcome) => ({
    lead_id_1: 402, lead_id: 402, clickup_operation_key: 'clickup-task:lead:402',
    clickup_correction_operation_key: 'clickup-task-correction:lead:402:abc',
    clickup_correction_requirement: '• 80 bloques',
    statusCode: 200, body: { id: '86e3qf426' }, idempotent_replay: true, operation_outcome: 'succeeded',
    correction_outcome: correctionOutcome,
  });

  test('a succeeded correction reports the requirement the task now shows', () => {
    const out = runNode('normalize-clickup-result.js', merged('succeeded'));
    expect(out).toMatchObject({
      clickup_correction_operation_key: 'clickup-task-correction:lead:402:abc',
      clickup_correction_outcome: 'succeeded',
      clickup_synced_requirement: '• 80 bloques',
    });
    expect(JSON.parse(out.metadata_json)).toMatchObject({ correction_outcome: 'succeeded' });
  });

  test('a failed correction keeps the task requirement unknown to the lead', () => {
    const out = runNode('normalize-clickup-result.js', merged('failed'));
    expect(out.clickup_correction_outcome).toBe('failed');
    expect(out.clickup_synced_requirement).toBe('');
  });

  test('no correction reports none', () => {
    const out = runNode('normalize-clickup-result.js', { ...merged(undefined), clickup_correction_operation_key: undefined });
    expect(out.clickup_correction_operation_key).toBe('');
    expect(out.clickup_correction_outcome).toBe('');
  });
});
