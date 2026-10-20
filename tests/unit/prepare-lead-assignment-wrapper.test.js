import fs from 'node:fs';
import { describe, expect, test } from 'vitest';

const fixturePath = 'tests/fixtures/workflow-nodes/crm-lead-creation-and-assignment/prepare-lead-assignment.js';

const runCodeNode = (source, items, env = {}) => new Function('items', '$env', source)(items, env);

// This fixture has no `if (typeof items !== 'undefined')` guard and no
// module.exports at all — importing/requiring it directly throws
// `ReferenceError: items is not defined`, which is exactly why it had zero
// test coverage before this file: it can only be exercised as a raw n8n
// Code node body.
describe('Prepare Lead Assignment — real n8n Code node wrapper', () => {
  test('builds a qualified lead when service/city/requirement are all present and no commercial field is missing', () => {
    const source = fs.readFileSync(fixturePath, 'utf8');
    const output = runCodeNode(source, [
      {
        json: {
          conversation_id: 100,
          phone_number: '56900000004',
          service: 'Baldosas',
          city: 'Santiago',
          requirement: 'Patio',
          commercial_missing_fields: [],
        },
      },
    ]);

    expect(output).toHaveLength(1);
    expect(output[0].json.is_qualified).toBe(true);
    expect(output[0].json.lead_status_code).toBe('qualified_complete');
    expect(output[0].json.rotation_key).toBe('whatsapp:default');
  });

  test('throws a BLOCKED payload instead of creating a lead when commercial fields are missing', () => {
    const source = fs.readFileSync(fixturePath, 'utf8');

    expect(() => runCodeNode(source, [
      {
        json: {
          conversation_id: 100,
          phone_number: '56900000004',
          service: 'Baldosas',
          city: 'Santiago',
          requirement: 'Patio',
          commercial_missing_fields: ['product'],
        },
      },
    ])).toThrow(/^BLOCKED\|/);
  });

  test('creates a v3 material pickup lead without city and does not invent a factory commune', () => {
    const source = fs.readFileSync(fixturePath, 'utf8');
    const [output] = runCodeNode(source, [{ json: {
      conversation_id: 100, phone_number: '56900000004', service: 'retiro', city: null,
      requirement: 'Pastelones 100 unidades', commercial_missing_fields: [],
      qualification_context: { product: 'Pastelones', quantity: '100 unidades', service_scope: 'material', fulfillment: 'pickup' },
    } }]);
    expect(output.json.is_qualified).toBe(true);
    expect(output.json.city).toBeNull();
    expect(output.json.qualification_context.commune).toBeUndefined();
  });

  test.each([
    ['delivery', { service_scope: 'material', fulfillment: 'delivery' }],
    ['installation', { service_scope: 'installation' }],
  ])('%s still blocks lead creation without city', (_profile, qualificationContext) => {
    const source = fs.readFileSync(fixturePath, 'utf8');
    expect(() => runCodeNode(source, [{ json: {
      conversation_id: 100, phone_number: '56900000004', service: 'material', city: null,
      requirement: 'Pastelones 100 unidades', commercial_missing_fields: [], qualification_context: qualificationContext,
    } }])).toThrow(/faltan ciudad/);
  });

  // There is no separate company track: a company picking up material follows
  // the same pickup rule as anyone else, so its city stays inapplicable.
  test.each([
    ['company customer', { service_scope: 'material', fulfillment: 'pickup', customer_type: 'b2b' }],
    ['lead class D', { service_scope: 'material', fulfillment: 'pickup', lead_class: 'D' }],
  ])('%s picking up material creates the lead without city', (_profile, qualificationContext) => {
    const source = fs.readFileSync(fixturePath, 'utf8');
    const [output] = runCodeNode(source, [{ json: {
      conversation_id: 100, phone_number: '56900000004', service: 'material', city: null,
      requirement: 'Pastelones 100 unidades', commercial_missing_fields: [],
      commercial_policy_profile: 'retiro', qualification_context: qualificationContext,
    } }]);
    expect(output.json.is_qualified).toBe(true);
    expect(output.json.city).toBeNull();
  });
});

// Owner decision 2026-10-14: a lead from a test phone goes to the test seller
// (the Hormiglass account), never into the real sellers' rotation.
describe('Prepare Lead Assignment — test phones', () => {
  const run = (phone, env) => runCodeNode(fs.readFileSync(fixturePath, 'utf8'), [{ json: {
    conversation_id: 100, phone_number: phone, service: 'despacho', city: 'Maipú',
    requirement: 'Adoquines 50 m2', commercial_missing_fields: [],
  } }], env)[0].json;
  const testEnv = { LEAD_TEST_PHONE_NUMBERS: '56997093038, +56 9 1111 2222', LEAD_TEST_SELLER_ID: '6' };

  test('a listed phone, in any format, is routed to the test seller', () => {
    expect(run('56997093038', testEnv).test_seller_id).toBe('6');
    expect(run('+56911112222', testEnv).test_seller_id).toBe('6');
  });

  test('any other phone keeps the rotation', () => {
    expect(run('56900000004', testEnv).test_seller_id).toBe('');
  });

  test('without both variables nobody is routed to a test seller', () => {
    expect(run('56997093038', {}).test_seller_id).toBe('');
    expect(run('56997093038', { LEAD_TEST_PHONE_NUMBERS: '56997093038' }).test_seller_id).toBe('');
    expect(run('56997093038', { ...testEnv, LEAD_TEST_SELLER_ID: '__PENDIENTE__' }).test_seller_id).toBe('');
  });
});
