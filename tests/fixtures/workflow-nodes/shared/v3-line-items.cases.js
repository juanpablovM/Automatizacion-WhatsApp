// =============================================================================
// v3-line-items.cases.js — the single source of truth for how the item-aware
// state reducer must behave. Every case here is asserted against BOTH the JS
// reducer (`reduceV3StateMutations` in v3-line-items.js, exercised by the
// Vitest unit suite) and the SQL reducer (`apply_v3_state_mutations`, defined
// in infra/postgres/migrations/025_item_aware_v3_state_mutations.sql,
// exercised by the Postgres parity integration suite). Keeping one table
// keeps both implementations honest against the same behavior instead of two
// hand-written expectations drifting apart.
// -----------------------------------------------------------------------------
// Each case has `name`, `context` (the snapshot before the turn), `mutations`
// (the decision's state_mutations for this turn) and either `expectedContext`
// (the snapshot after the turn) or `expectedError` (a RegExp source string
// both reducers must raise instead of returning).
// =============================================================================

const primaryItem = (overrides = {}) => ({
  item_id: 'li_0',
  product: null,
  quantity: null,
  measurements: null,
  catalog_ref: null,
  requested_label: null,
  ...overrides,
});

const tenItems = Array.from({ length: 10 }, (_, index) => ({
  item_id: `li_${index}`,
  product: `Producto ${index}`,
  quantity: index + 1,
  measurements: null,
  catalog_ref: null,
  requested_label: null,
}));

const LINE_ITEM_REDUCER_CASES = [
  {
    name: 'promotes an item field from a flat quote into the item model',
    context: {},
    mutations: [
      { operation: 'set', field: 'product', observation_id: 'obs-product', replaces_fact_id: null, projected_value: 'Bloques de Hormigón' },
      { operation: 'set', field: 'quantity', observation_id: 'obs-quantity', replaces_fact_id: null, projected_value: 100 },
    ],
    expectedContext: {
      product: 'Bloques de Hormigón',
      quantity: 100,
      measurements: null,
      line_items: [primaryItem({ product: 'Bloques de Hormigón', quantity: 100 })],
      line_items_projection: { product: 'Bloques de Hormigón', quantity: 100, measurements: null },
      line_items_schema: 'line_items/v1',
    },
  },
  {
    name: 'quote-level mutations alone never introduce the item model',
    context: { city: 'Santiago' },
    mutations: [
      { operation: 'set', field: 'service', observation_id: 'obs-service', replaces_fact_id: null, projected_value: 'installation' },
    ],
    expectedContext: { city: 'Santiago', service: 'installation' },
  },
  {
    name: 'upserts an existing item by item_id instead of duplicating it',
    context: {
      product: 'Bloques de Hormigón',
      quantity: 100,
      measurements: null,
      line_items: [primaryItem({ product: 'Bloques de Hormigón', quantity: 100 })],
      line_items_projection: { product: 'Bloques de Hormigón', quantity: 100, measurements: null },
      line_items_schema: 'line_items/v1',
    },
    mutations: [
      { operation: 'set', field: 'quantity', item_id: 'li_0', observation_id: 'obs-quantity-2', replaces_fact_id: null, projected_value: 120 },
    ],
    expectedContext: {
      product: 'Bloques de Hormigón',
      quantity: 120,
      measurements: null,
      line_items: [primaryItem({ product: 'Bloques de Hormigón', quantity: 120 })],
      line_items_projection: { product: 'Bloques de Hormigón', quantity: 120, measurements: null },
      line_items_schema: 'line_items/v1',
    },
  },
  {
    name: 'rejects a flat mutation targeting the line_items system key',
    context: {},
    mutations: [
      { operation: 'set', field: 'line_items', observation_id: 'obs-illegal', replaces_fact_id: null, projected_value: [] },
    ],
    expectedError: 'invalid v3 mutation field',
  },
  {
    name: 'rejects more than 10 items after the reducer runs',
    context: {
      product: tenItems[0].product,
      quantity: tenItems[0].quantity,
      measurements: null,
      line_items: tenItems,
      line_items_projection: { product: tenItems[0].product, quantity: tenItems[0].quantity, measurements: null },
      line_items_schema: 'line_items/v1',
    },
    mutations: [
      { operation: 'set', field: 'product', item_id: 'li_10', observation_id: 'obs-eleventh', replaces_fact_id: null, projected_value: 'Producto 10' },
    ],
    expectedError: 'line_items_limit_exceeded',
  },
  {
    name: 'remove_item is a no-op when the id is already absent',
    context: {},
    mutations: [
      { operation: 'remove_item', item_id: 'li_missing' },
    ],
    expectedContext: {
      line_items: [],
      line_items_projection: { product: null, quantity: null, measurements: null },
      line_items_schema: 'line_items/v1',
    },
  },
  {
    name: 'reconciles a legacy writer that wrote flat fields after an item model existed (D3)',
    context: {
      product: 'New By Legacy Writer',
      quantity: '5',
      measurements: null,
      line_items: [primaryItem({ product: 'Old', quantity: '5' })],
      line_items_projection: { product: 'Old', quantity: '5', measurements: null },
      line_items_schema: 'line_items/v1',
    },
    mutations: [],
    expectedContext: {
      product: 'New By Legacy Writer',
      quantity: '5',
      measurements: null,
      line_items: [primaryItem({ product: 'New By Legacy Writer', quantity: '5' })],
      line_items_projection: { product: 'New By Legacy Writer', quantity: '5', measurements: null },
      line_items_schema: 'line_items/v1',
    },
  },
];

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { LINE_ITEM_REDUCER_CASES, primaryItem, tenItems };
}
