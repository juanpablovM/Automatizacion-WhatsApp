// =============================================================================
// Quote correction (owner decision 2026-10-14): the ClickUp sync updates the
// existing task when the lead's requirement differs from the one the task last
// received (leads.clickup_synced_requirement, migration 035). Load ClickUp
// Context claims the correction once per new requirement; Persist ClickUp
// Result records its outcome and, only on success, the requirement the task
// now shows. Every test runs inside a transaction that is rolled back.
// =============================================================================
import fs from 'node:fs';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';

const integration = process.env.TEST_PG_INTEGRATION === '1' ? describe : describe.skip;
const connection = {
  host: process.env.TEST_PGHOST || '127.0.0.1',
  port: Number(process.env.TEST_PGPORT || 55433),
  database: process.env.TEST_PGDATABASE || 'testdb',
  user: process.env.TEST_PGUSER || 'test',
  password: process.env.TEST_PGPASSWORD || 'test',
};
const syncNodes = JSON.parse(fs.readFileSync('n8n/workflows/crm-clickup-sync-lead.json', 'utf8')).nodes;
const queryNode = (name) => {
  const node = syncNodes.find((entry) => entry.name === name);
  return { sql: node.parameters.query, params: node.parameters.additionalFields.queryParams.split(',').map((param) => param.trim()) };
};
const loadContext = queryNode('Load ClickUp Context');
const persistResult = queryNode('Persist ClickUp Result');

integration('ClickUp sync of a corrected quote', () => {
  const client = new pg.Client(connection);
  let leadId;

  beforeAll(async () => { await client.connect(); });
  afterAll(async () => { await client.end(); });
  beforeEach(async () => {
    await client.query('BEGIN');
    await client.query(`INSERT INTO lead_statuses (code, label, sort_order) VALUES
      ('assigned', 'Assigned', 1), ('created_in_clickup', 'Created', 2), ('error', 'Error', 3)
      ON CONFLICT (code) DO NOTHING`);
    leadId = (await client.query(`INSERT INTO leads (phone_number, lead_status_id, clickup_task_id, clickup_task_url,
      clickup_synced_requirement, service, city, requirement)
      SELECT '56900000496', id, '86e3qf426', 'https://app.clickup.com/t/86e3qf426', '• 50 bloques',
        'despacho', 'Maipú', '• 80 bloques'
      FROM lead_statuses WHERE code = 'assigned' RETURNING id`)).rows[0].id;
  });
  afterEach(async () => { await client.query('ROLLBACK'); });

  const load = async () => (await client.query(loadContext.sql, [leadId])).rows[0];
  const persist = (values) => {
    const input = {
      lead_id: leadId, is_success: true, clickup_task_id: '86e3qf426',
      clickup_task_url: 'https://app.clickup.com/t/86e3qf426', event_name: 'clickup_task_sync', result: 'success',
      after_payload_json: '{}', metadata_json: '{}', comment_enabled: false, comment_text: '',
      idempotency_in_progress: false, clickup_operation_key: `clickup-task:lead:${leadId}`, idempotent_replay: true,
      operation_outcome: 'succeeded', reconciliation_required: false, retry_safe: false,
      clickup_synced_requirement: '', clickup_correction_operation_key: '', clickup_correction_outcome: '',
      ...values,
    };
    return client.query(persistResult.sql, persistResult.params.map((name) => input[name]));
  };
  const lead = async () => (await client.query(
    'SELECT clickup_synced_requirement, clickup_task_id FROM leads WHERE id = $1', [leadId],
  )).rows[0];
  const operation = async (key) => (await client.query(
    'SELECT status, operation_type, entity_id FROM external_operations WHERE operation_key = $1', [key],
  )).rows[0];

  test('a changed requirement claims one correction of the existing task', async () => {
    const first = await load();
    expect(first.should_create_clickup).toBe(false);
    expect(first.existing_clickup_task_id).toBe('86e3qf426');
    expect(first.should_update_clickup).toBe(true);
    expect(first.clickup_requirement_before).toBe('• 50 bloques');
    expect(first.clickup_correction_operation_key).toMatch(new RegExp(`^clickup-task-correction:lead:${leadId}:[0-9a-f]{32}$`));
    expect(await operation(first.clickup_correction_operation_key)).toMatchObject({
      status: 'processing', operation_type: 'clickup_task_correction', entity_id: String(leadId),
    });

    const replay = await load();
    expect(replay.should_update_clickup).toBe(false);
  });

  test('an unchanged requirement claims nothing', async () => {
    await client.query("UPDATE leads SET requirement = '• 50 bloques' WHERE id = $1", [leadId]);
    const row = await load();
    expect(row.should_update_clickup).toBe(false);
    expect(row.clickup_correction_operation_key).toBeNull();
  });

  test('a succeeded correction records the requirement the task now shows', async () => {
    const { clickup_correction_operation_key: key } = await load();
    await persist({ clickup_synced_requirement: '• 80 bloques', clickup_correction_operation_key: key, clickup_correction_outcome: 'succeeded' });
    expect(await lead()).toEqual({ clickup_synced_requirement: '• 80 bloques', clickup_task_id: '86e3qf426' });
    expect((await operation(key)).status).toBe('succeeded');
    expect((await load()).should_update_clickup).toBe(false);
  });

  test('a failed correction leaves the synced requirement as it was', async () => {
    const { clickup_correction_operation_key: key } = await load();
    await persist({ clickup_correction_operation_key: key, clickup_correction_outcome: 'failed' });
    expect((await lead()).clickup_synced_requirement).toBe('• 50 bloques');
    expect((await operation(key)).status).toBe('failed');
  });

  test('a created task records the requirement it was created with', async () => {
    await client.query('UPDATE leads SET clickup_task_id = NULL, clickup_task_url = NULL, clickup_synced_requirement = NULL WHERE id = $1', [leadId]);
    const row = await load();
    expect(row.should_create_clickup).toBe(true);
    expect(row.should_update_clickup).toBe(false);
    await persist({ idempotent_replay: false });
    expect(await lead()).toEqual({ clickup_synced_requirement: '• 80 bloques', clickup_task_id: '86e3qf426' });
  });
});
