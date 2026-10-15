// =============================================================================
// Owner decision 2026-10-14: a lead from a test phone is assigned to the test
// seller (the Hormiglass account) and leaves the real sellers' rotation alone.
// Prepare Lead Assignment resolves `test_seller_id`; the Persist Lead And
// Rotation node assigns that seller even while it is out of the rotation
// (is_active = false) and does not advance the rotation's next seller.
// Every test runs inside a transaction that is rolled back.
// =============================================================================
import fs from 'node:fs';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, test } from 'vitest';

const enabled = process.env.TEST_PG_INTEGRATION === '1';
const describeIntegration = enabled ? describe : describe.skip;
const connection = {
  host: process.env.TEST_PGHOST || '127.0.0.1',
  port: Number(process.env.TEST_PGPORT || 55433),
  database: process.env.TEST_PGDATABASE || 'testdb',
  user: process.env.TEST_PGUSER || 'test',
  password: process.env.TEST_PGPASSWORD || 'test',
};

const persistNode = JSON.parse(fs.readFileSync('n8n/workflows/crm-lead-creation-and-assignment.json', 'utf8'))
  .nodes.find((node) => node.name === 'Persist Lead And Rotation');
const persistSql = persistNode.parameters.query;
const paramNames = persistNode.parameters.additionalFields.queryParams.split(',');

describeIntegration('lead assignment to the test seller', () => {
  const client = new pg.Client(connection);
  let sellers;
  let conversationStatusId;

  beforeAll(async () => { await client.connect(); });
  afterAll(async () => { await client.end(); });

  beforeEach(async () => {
    await client.query('BEGIN');
    await client.query(`INSERT INTO lead_statuses (code, label, sort_order) VALUES
      ('qualified_complete', 'Qualified', 1), ('assigned', 'Assigned', 2)`);
    ({ rows: [{ id: conversationStatusId }] } = await client.query(
      "INSERT INTO conversation_statuses (code, label, sort_order) VALUES ('open', 'Open', 1) RETURNING id",
    ));
    const { rows } = await client.query(`INSERT INTO sellers (name, clickup_user_id, is_active, sort_order) VALUES
      ('Catherine', '101', TRUE, 1), ('Edith', '102', TRUE, 2), ('Lorena', '103', TRUE, 3),
      ('Hormiglass (pruebas)', '900', FALSE, 6)
      RETURNING id, name`);
    sellers = Object.fromEntries(rows.map((row) => [row.name, String(row.id)]));
    await client.query(
      "INSERT INTO assignment_rotations (rotation_key, next_seller_id) VALUES ('whatsapp:default', $1)",
      [sellers.Catherine],
    );
  });
  afterEach(async () => { await client.query('ROLLBACK'); });

  const persist = async ({ phone, testSellerId = '' }) => {
    const { rows: [conversation] } = await client.query(
      'INSERT INTO conversations (phone_number, conversation_status_id) VALUES ($1, $2) RETURNING id',
      [phone, conversationStatusId],
    );
    const input = {
      previous_lead_id: '', source_number_id: '', external_contact_id: '', whatsapp_name: 'Cliente',
      phone_number: phone, service: 'despacho', city: 'Maipú', requirement: 'Adoquines 50 m2',
      lead_status_code: 'qualified_complete', is_qualified: 'true', is_partial: 'false',
      rotation_key: 'whatsapp:default', conversation_id: String(conversation.id),
      qualification_context: '{}', test_seller_id: testSellerId,
    };
    const { rows: [lead] } = await client.query(persistSql, paramNames.map((name) => input[name.trim()]));
    // A fresh lead gets its seller in Finalize Lead Assignment, from this row.
    const { rows: [assignment] } = await client.query(
      'SELECT seller_id, assignment_result, reason FROM lead_assignments WHERE lead_id = $1', [lead.lead_id],
    );
    return { ...assignment, seller_id: String(assignment.seller_id) };
  };
  const nextSellerId = async () => String((await client.query(
    "SELECT next_seller_id FROM assignment_rotations WHERE rotation_key = 'whatsapp:default'",
  )).rows[0].next_seller_id);

  test('a real customer follows the rotation', async () => {
    const first = await persist({ phone: '56900000001' });
    expect(first.seller_id).toBe(sellers.Catherine);
    expect(first.reason).toBe('round_robin');
    expect(await nextSellerId()).toBe(sellers.Edith);
  });

  test('a test lead goes to the test seller and leaves the rotation untouched', async () => {
    await persist({ phone: '56900000001' });
    const testLead = await persist({ phone: '56997093038', testSellerId: sellers['Hormiglass (pruebas)'] });
    expect(testLead.seller_id).toBe(sellers['Hormiglass (pruebas)']);
    expect(testLead.assignment_result).toBe('assigned');
    expect(testLead.reason).toBe('test_seller');
    expect(await nextSellerId()).toBe(sellers.Edith);

    const nextReal = await persist({ phone: '56900000002' });
    expect(nextReal.seller_id).toBe(sellers.Edith);
  });

  test('a missing test seller never falls back to a real seller', async () => {
    await client.query('UPDATE sellers SET deleted_at = NOW() WHERE id = $1', [sellers['Hormiglass (pruebas)']]);
    const testLead = await persist({ phone: '56997093038', testSellerId: sellers['Hormiglass (pruebas)'] });
    expect(testLead.assignment_result).toBe('failed');
    expect(testLead.reason).toBe('no_notifiable_seller');
    expect(await nextSellerId()).toBe(sellers.Catherine);
  });
});
