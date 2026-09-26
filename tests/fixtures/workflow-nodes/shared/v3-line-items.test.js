// The v3 contract stores exactly one product/quantity/measurements per quote.
// This is the single source of truth for the item-aware `line_items[]` model:
// dual-read of historical flat rows, item identity, the state-mutation
// reducer, the flat projection mirror, and the requirement composer. The SQL
// twin (`apply_v3_state_mutations`) is asserted against the same case table
// in tests/integration/v3-line-items-parity.postgres.test.js.
import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const {
  readLineItems,
  deriveItemId,
  reduceV3StateMutations,
  projectFlat,
  composeRequirement,
} = require('./v3-line-items.js');
const { LINE_ITEM_REDUCER_CASES } = require('./v3-line-items.cases.js');

describe('readLineItems — dual-read of flat and item-aware qualification_context', () => {
  test('maps a flat qualification_context to a single implicit item [li_0]', () => {
    const items = readLineItems({ product: 'Bloques de Hormigón', quantity: 100, measurements: null });

    expect(items).toEqual([{
      item_id: 'li_0',
      product: 'Bloques de Hormigón',
      quantity: 100,
      measurements: null,
      catalog_ref: null,
      requested_label: null,
    }]);
  });

  test('returns no items for a flat context that never set any item field', () => {
    expect(readLineItems({ city: 'Santiago' })).toEqual([]);
  });

  test('returns the stored items unchanged when the flat projection still matches', () => {
    const context = {
      product: 'Alambre de Púas', quantity: '500 ml', measurements: null,
      line_items: [{
        item_id: 'li_0', product: 'Alambre de Púas', quantity: '500 ml', measurements: null,
        catalog_ref: null, requested_label: null,
      }],
      line_items_projection: { product: 'Alambre de Púas', quantity: '500 ml', measurements: null },
      line_items_schema: 'line_items/v1',
    };

    expect(readLineItems(context)).toEqual(context.line_items);
  });

  test('D3 reconcile: a legacy writer after rollback overwrites the primary item with the flat values', () => {
    const context = {
      product: 'New By Legacy Writer', quantity: '5', measurements: null,
      line_items: [{
        item_id: 'li_0', product: 'Old', quantity: '5', measurements: null,
        catalog_ref: null, requested_label: null,
      }],
      line_items_projection: { product: 'Old', quantity: '5', measurements: null },
      line_items_schema: 'line_items/v1',
    };

    expect(readLineItems(context)).toEqual([{
      item_id: 'li_0', product: 'New By Legacy Writer', quantity: '5', measurements: null,
      catalog_ref: null, requested_label: null,
    }]);
  });
});

describe('deriveItemId — fixed ids inside the immutable decision', () => {
  test('derives li_ + sha256("line_item/v1\\0conv\\0turn\\0handle")[0:12] for a new-item handle', () => {
    const id = deriveItemId('conv-1', 'turn-1', 'new:1');

    expect(id).toMatch(/^li_[0-9a-f]{12}$/);
    // Triangulation: a different handle must derive a different id, proving
    // the hash — not a hardcoded value — drives the output.
    expect(id).not.toBe(deriveItemId('conv-1', 'turn-1', 'new:2'));
    expect(id).not.toBe(deriveItemId('conv-2', 'turn-1', 'new:1'));
    // Deterministic: replaying the exact same inputs reproduces the exact id.
    expect(deriveItemId('conv-1', 'turn-1', 'new:1')).toBe(id);
  });

  test('maps a flat row (no handle) to the constant li_0', () => {
    expect(deriveItemId('conv-1', 'turn-1', null)).toBe('li_0');
    expect(deriveItemId('conv-1', 'turn-1')).toBe('li_0');
  });
});

describe('reduceV3StateMutations — the shared JS/SQL state-mutation case table', () => {
  for (const testCase of LINE_ITEM_REDUCER_CASES) {
    test(testCase.name, () => {
      if (testCase.expectedError) {
        expect(() => reduceV3StateMutations(testCase.context, testCase.mutations))
          .toThrow(new RegExp(testCase.expectedError));
        return;
      }
      expect(reduceV3StateMutations(testCase.context, testCase.mutations)).toEqual(testCase.expectedContext);
    });
  }

  test('replaying a committed turn is idempotent: no duplicate item on reapply', () => {
    const mutations = [
      { operation: 'set', field: 'product', projected_value: 'Bloques de Hormigón' },
      { operation: 'set', field: 'quantity', projected_value: 100 },
    ];
    const first = reduceV3StateMutations({}, mutations);
    const replay = reduceV3StateMutations(first, mutations);

    expect(replay.line_items).toHaveLength(1);
    expect(replay).toEqual(first);
  });
});

describe('projectFlat — mirrors the primary item into the flat compatibility fields', () => {
  test('mirrors the first item in array order', () => {
    const items = [
      { item_id: 'li_0', product: 'Bloques de Hormigón', quantity: 100, measurements: null },
      { item_id: 'li_1', product: 'Alambre de Púas', quantity: '500 ml', measurements: null },
    ];

    expect(projectFlat({}, items)).toEqual({ product: 'Bloques de Hormigón', quantity: 100, measurements: null });
  });

  test('deletes the flat fields when no items remain', () => {
    const context = { city: 'Santiago', product: 'Bloques de Hormigón', quantity: 100, measurements: null };

    const projected = projectFlat(context, []);

    expect(projected).toEqual({ city: 'Santiago' });
    expect(projected).not.toHaveProperty('product');
    expect(projected).not.toHaveProperty('quantity');
    expect(projected).not.toHaveProperty('measurements');
  });
});

describe('composeRequirement — single-item output stays byte-identical to the legacy string', () => {
  test('matches the current legacy requirement string for one item', () => {
    const requirement = composeRequirement(
      [{ item_id: 'li_0', product: 'Bloques de Hormigón', quantity: 100, measurements: null }],
      {},
    );

    expect(requirement).toBe('Bloques de Hormigón 100');
  });

  test('appends measurements and the quote-level use_case, matching the legacy field order', () => {
    const requirement = composeRequirement(
      [{ item_id: 'li_0', product: 'hormigon H25', quantity: '20 m3', measurements: null }],
      { use_case: 'losa' },
    );

    expect(requirement).toBe('hormigon H25 20 m3 losa');
  });

  test('is empty when the single item has no product, never inventing a requirement', () => {
    expect(composeRequirement([{ item_id: 'li_0', product: null, quantity: '500 ml', measurements: null }], {})).toBe('');
  });

  test('renders one bullet line per item for a multi-item quote, plus a Uso line when present', () => {
    const requirement = composeRequirement(
      [
        { item_id: 'li_0', product: 'Cierros de Hormigón', quantity: null, measurements: '3 metros de altura' },
        { item_id: 'li_1', product: 'Alambre de Púas', quantity: '500 ml', measurements: null },
      ],
      { use_case: 'perimetral' },
    );

    expect(requirement).toBe(
      '• Cierros de Hormigón — , 3 metros de altura\n• Alambre de Púas — 500 ml\nUso: perimetral',
    );
  });
});
