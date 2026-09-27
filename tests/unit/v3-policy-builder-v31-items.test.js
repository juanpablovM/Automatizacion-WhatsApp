// Slice 2a (design.md task 2a.21/2a.22, dark): `buildV3PolicyInput` emits
// item facts, an item-aware `line_items` goal, and item-scoped mutation
// authority only when explicitly asked for `version: 'v3.1'`. The default
// (no options, or `version: 'v3'`) stays exactly the Slice 1 behavior —
// proven byte-identical by v3-policy-builder-line-items-regression.test.js.
import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const { buildV3PolicyInput } = require('../fixtures/workflow-nodes/shared/v3-policy-builder.js');

const row = (overrides = {}) => ({
  inbound_event_id: 'event-31',
  conversation_id: 'conversation-31',
  conversation_revision: 1,
  external_message_id: 'message-31',
  text_body: 'pandereta de 3 metros de altura con alambre púa. Son aprox 500 ml en la comuna de Lo Prado',
  qualification_context: {},
  ...overrides,
});

describe('buildV3PolicyInput — v3.1 item facts/goals/authority gate (2a.21/2a.22)', () => {
  test('the default (v3) input never emits item facts or line_items authority', () => {
    const input = buildV3PolicyInput(row({
      qualification_context: { product: 'Adoquín', quantity: 10, commune: 'Santiago' },
    }));

    expect(input.facts.some((fact) => fact.fact_id?.startsWith('fact:item:'))).toBe(false);
    expect(input.goals.some((goal) => goal.goal_id === 'line_items')).toBe(false);
    expect(input.allowed_mutations.some((mutation) => mutation.operation === 'remove_item')).toBe(false);
    expect(input.version).toBe('v3');
  });

  test('version: v3.1 emits one fact per existing item field and drops the flat product/quantity facts', () => {
    const input = buildV3PolicyInput(row({
      qualification_context: {
        line_items: [
          { item_id: 'li_a', product: 'Adoquín', quantity: 10, measurements: null, catalog_ref: null, requested_label: null },
          { item_id: 'li_b', product: 'Pastelón', quantity: 5, measurements: null, catalog_ref: null, requested_label: null },
        ],
        line_items_projection: { product: 'Adoquín', quantity: 10, measurements: null },
        line_items_schema: 'line_items/v1',
        product: 'Adoquín', quantity: 10, measurements: null,
        commune: 'Santiago',
      },
    }), { version: 'v3.1' });

    expect(input.version).toBe('v3.1');
    expect(input.facts).toContainEqual(expect.objectContaining({ fact_id: 'fact:item:li_a:product', field: 'product', value: 'Adoquín' }));
    expect(input.facts).toContainEqual(expect.objectContaining({ fact_id: 'fact:item:li_a:quantity', field: 'quantity', value: 10 }));
    expect(input.facts).toContainEqual(expect.objectContaining({ fact_id: 'fact:item:li_b:product', field: 'product', value: 'Pastelón' }));
    expect(input.facts.some((fact) => fact.fact_id === 'fact:product')).toBe(false);
    expect(input.facts.some((fact) => fact.fact_id === 'fact:quantity')).toBe(false);
    // Quote-level facts stay unaffected by the item gate.
    expect(input.facts).toContainEqual(expect.objectContaining({ field: 'commune', value: 'Santiago' }));
  });

  test('version: v3.1 adds the line_items goal and item-scoped mutation authority', () => {
    const input = buildV3PolicyInput(row({ qualification_context: {} }), { version: 'v3.1' });

    expect(input.goals).toContainEqual(expect.objectContaining({ goal_id: 'line_items', importance: 'required_for_effect' }));
    expect(input.allowed_mutations).toContainEqual({ operation: 'set', concept: 'product', field: 'product' });
    expect(input.allowed_mutations).toContainEqual({ operation: 'replace', concept: 'product', field: 'product' });
    expect(input.allowed_mutations).toContainEqual({ operation: 'set', concept: 'quantity', field: 'quantity' });
    expect(input.allowed_mutations).toContainEqual({ operation: 'set', concept: 'measurements', field: 'measurements' });
    expect(input.allowed_mutations).toContainEqual({ operation: 'remove_item', concept: 'line_items', field: null });
  });

  test('version: v3.1 marks line_items resolved only when every item has product and quantity', () => {
    const resolvedInput = buildV3PolicyInput(row({
      qualification_context: {
        line_items: [{ item_id: 'li_a', product: 'Adoquín', quantity: 10, measurements: null, catalog_ref: null, requested_label: null }],
        line_items_projection: { product: 'Adoquín', quantity: 10, measurements: null },
        line_items_schema: 'line_items/v1',
        product: 'Adoquín', quantity: 10, measurements: null,
      },
    }), { version: 'v3.1' });
    const unresolvedInput = buildV3PolicyInput(row({
      qualification_context: {
        line_items: [{ item_id: 'li_a', product: null, quantity: null, measurements: null, catalog_ref: null, requested_label: null }],
        line_items_projection: { product: null, quantity: null, measurements: null },
        line_items_schema: 'line_items/v1',
      },
    }), { version: 'v3.1' });

    expect(resolvedInput.goals.find((goal) => goal.goal_id === 'line_items')).toMatchObject({ status: 'resolved' });
    expect(unresolvedInput.goals.find((goal) => goal.goal_id === 'line_items')).toMatchObject({ status: 'unresolved' });
  });
});
