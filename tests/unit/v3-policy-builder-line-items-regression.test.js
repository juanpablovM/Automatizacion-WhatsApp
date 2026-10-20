// Approval test for the Slice 1 "read-through" wiring (design.md task list
// item 1.23): `buildV3PolicyInput` starts reading `product`/`quantity`/
// `measurements` from the primary item `readLineItems` derives, instead of
// straight off `qualification_context`. For every historical flat row and
// every current single-item v3 conversation, the primary item's fields are
// byte-identical to the flat fields, so this wiring must never change a
// single fact, goal, or allowed mutation the policy compiles today.
import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const { buildV3PolicyInput } = require(
  '../fixtures/workflow-nodes/shared/v3-policy-builder.js',
);

const row = (overrides = {}) => ({
  inbound_event_id: 'event-1',
  conversation_id: 'conversation-1',
  conversation_revision: 3,
  external_message_id: 'message-1',
  text_body: 'Necesito 20 m3 de hormigón H25',
  qualification_context: {
    product: 'hormigon H25',
    quantity: '20 m3',
    commune: 'Santiago',
    service_scope: 'material',
    fulfillment: 'delivery',
  },
  ...overrides,
});

describe('buildV3PolicyInput — item-model read-through stays byte-identical (Slice 1)', () => {
  test('a single-item flat context compiles the exact same product/quantity facts and mutations', () => {
    const input = buildV3PolicyInput(row());

    const factFor = (field) => input.facts.find((fact) => fact.field === field);
    expect(factFor('product')).toMatchObject({ field: 'product', value: 'hormigon H25', fact_id: 'fact:product' });
    expect(factFor('quantity')).toMatchObject({ field: 'quantity', value: '20 m3', fact_id: 'fact:quantity' });

    const goalFor = (field) => input.goals.find((goal) => goal.goal_id === field);
    expect(goalFor('product')).toMatchObject({ status: 'resolved' });
    expect(goalFor('quantity')).toMatchObject({ status: 'resolved' });

    const mutationFor = (field) => input.allowed_mutations.find((mutation) => mutation.field === field);
    expect(mutationFor('product')).toMatchObject({ operation: 'replace', current_fact_id: 'fact:product' });
    expect(mutationFor('quantity')).toMatchObject({ operation: 'replace', current_fact_id: 'fact:quantity' });
  });

  test('a quote with no product/quantity yet still resolves both goals as unresolved, never inventing a fact', () => {
    const input = buildV3PolicyInput(row({ qualification_context: { commune: 'Santiago' } }));

    expect(input.facts.some((fact) => fact.field === 'product')).toBe(false);
    expect(input.facts.some((fact) => fact.field === 'quantity')).toBe(false);
    const goalFor = (field) => input.goals.find((goal) => goal.goal_id === field);
    expect(goalFor('product')).toMatchObject({ status: 'unresolved' });
    expect(goalFor('quantity')).toMatchObject({ status: 'unresolved' });
  });

  test('measurements read through the same primary item as product and quantity', () => {
    const input = buildV3PolicyInput(row({
      qualification_context: {
        product: 'Bloques de Hormigón', quantity: 100,
        measurements: { kind: 'area', name: 'losa', value: 100, unit: 'm2' },
      },
    }));

    const factFor = (field) => input.facts.find((fact) => fact.field === field);
    expect(factFor('measurements')).toMatchObject({
      field: 'measurements', value: { kind: 'area', name: 'losa', value: 100, unit: 'm2' },
    });
  });

  test('a historical flat conversation with no line_items key resolves through the same implicit item', () => {
    const withoutLineItems = buildV3PolicyInput(row());
    const withExplicitLineItems = buildV3PolicyInput(row({
      qualification_context: {
        product: 'hormigon H25', quantity: '20 m3', commune: 'Santiago',
        service_scope: 'material', fulfillment: 'delivery',
        line_items: [{
          item_id: 'li_0', product: 'hormigon H25', quantity: '20 m3', measurements: null,
          catalog_ref: null, requested_label: null,
        }],
        line_items_projection: { product: 'hormigon H25', quantity: '20 m3', measurements: null },
        line_items_schema: 'line_items/v1',
      },
    }));

    // The dual-read adapter must make the two rows produce identical facts:
    // an item-aware row and a plain historical flat row read the same values.
    expect(withExplicitLineItems.facts).toEqual(withoutLineItems.facts);
    expect(withExplicitLineItems.goals).toEqual(withoutLineItems.goals);
    expect(withExplicitLineItems.allowed_mutations).toEqual(withoutLineItems.allowed_mutations);
  });
});
