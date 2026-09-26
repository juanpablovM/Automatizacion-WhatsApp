// =============================================================================
// v3-line-items.js — the single source of truth for the item-aware
// `line_items[]` model added on top of the flat v3 qualification_context.
// -----------------------------------------------------------------------------
// A quote historically stored exactly one product/quantity/measurements at
// the top level. This file adds a dual-read adapter (`readLineItems`), a
// content-derived item identity (`deriveItemId`), the mutation reducer that
// mirrors `apply_v3_state_mutations` in SQL (`reduceV3StateMutations`), the
// flat-projection mirror kept for legacy readers (`projectFlat`), and the
// lead-requirement composer (`composeRequirement`).
//
// The SQL twin lives in
// infra/postgres/migrations/025_item_aware_v3_state_mutations.sql and is
// asserted against the exact same case table
// (tests/fixtures/workflow-nodes/shared/v3-line-items.cases.js) so both
// implementations stay in lockstep — see design.md decisions D1-D3, D9.
//
// Everything below is wrapped in one IIFE so only the five names this module
// exports become top-level identifiers. Code nodes get several `shared/*.js`
// files concatenated into one scope through `runtimes` in
// tests/scripts/sync-workflow-nodes.mjs, so an un-scoped helper name (like a
// generic `sha256` or `asObject`) would collide with another runtime's own
// top-level declaration of the same name.
// =============================================================================

const {
  readLineItems,
  deriveItemId,
  reduceV3StateMutations,
  projectFlat,
  composeRequirement,
} = (() => {
  const LINE_ITEM_VERSION = 'line_item/v1';
  const LINE_ITEM_SCHEMA = 'line_items/v1';
  const FLAT_ITEM_ID = 'li_0';
  const ITEM_FIELDS = ['product', 'quantity', 'measurements'];
  const RESERVED_ITEM_KEYS = new Set(['line_items', 'line_items_projection', 'line_items_schema']);
  const MAX_LINE_ITEMS = 10;

  const asObject = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const safe = (value, fallback = '') => String(value ?? fallback).trim();
  const cloneItem = (item) => ({ ...asObject(item) });

  // A minimal, dependency-free SHA-256 (same algorithm as
  // shared/v3-contract-runtime.js's `sha256`, duplicated on purpose: this
  // file must stay a standalone, n8n-safe runtime with no cross-file
  // `require`, since production Code nodes get it concatenated as raw source,
  // not loaded as a module).
  const SHA256_K = Object.freeze([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);
  const rotateRight = (value, bits) => (value >>> bits) | (value << (32 - bits));
  const sha256 = (value) => {
    const bytes = new TextEncoder().encode(String(value));
    const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
    const padded = new Uint8Array(paddedLength);
    padded.set(bytes);
    padded[bytes.length] = 0x80;
    const bitLength = BigInt(bytes.length) * 8n;
    const view = new DataView(padded.buffer);
    view.setUint32(paddedLength - 8, Number((bitLength >> 32n) & 0xffffffffn));
    view.setUint32(paddedLength - 4, Number(bitLength & 0xffffffffn));

    const hash = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    const words = new Uint32Array(64);
    for (let offset = 0; offset < paddedLength; offset += 64) {
      for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(offset + index * 4);
      for (let index = 16; index < 64; index += 1) {
        const left = words[index - 15];
        const right = words[index - 2];
        const sigma0 = rotateRight(left, 7) ^ rotateRight(left, 18) ^ (left >>> 3);
        const sigma1 = rotateRight(right, 17) ^ rotateRight(right, 19) ^ (right >>> 10);
        words[index] = (words[index - 16] + sigma0 + words[index - 7] + sigma1) >>> 0;
      }
      let [a, b, c, d, e, f, g, h] = hash;
      for (let index = 0; index < 64; index += 1) {
        const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
        const choice = (e & f) ^ (~e & g);
        const first = (h + sum1 + choice + SHA256_K[index] + words[index]) >>> 0;
        const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
        const majority = (a & b) ^ (a & c) ^ (b & c);
        const second = (sum0 + majority) >>> 0;
        h = g; g = f; f = e; e = (d + first) >>> 0;
        d = c; c = b; b = a; a = (first + second) >>> 0;
      }
      [a, b, c, d, e, f, g, h].forEach((part, index) => { hash[index] = (hash[index] + part) >>> 0; });
    }
    return hash.map((part) => part.toString(16).padStart(8, '0')).join('');
  };

  // D1: a comparable projection normalizes "field absent" and "field null" to
  // the same shape, so a dual-read reconcile never fires on a difference that
  // only exists because one side omitted a key.
  const comparableProjection = (source) => {
    const value = asObject(source);
    return {
      product: value.product ?? null,
      quantity: value.quantity ?? null,
      measurements: value.measurements ?? null,
    };
  };

  const newItem = (itemId) => ({
    item_id: itemId, product: null, quantity: null, measurements: null,
    catalog_ref: null, requested_label: null,
  });

  // D3: dual-read. A row with no `line_items` yet is a historical flat quote,
  // mapped to a single implicit item [li_0]. A row that already has
  // `line_items` but whose flat projection no longer matches the stored
  // projection was touched by a legacy writer after a rollback, so the flat
  // values win for the primary (first) item.
  const readLineItems = (context) => {
    const ctx = asObject(context);
    const stored = Array.isArray(ctx.line_items) ? ctx.line_items.map(cloneItem) : null;

    if (stored === null) {
      const hasFlatItemData = ITEM_FIELDS.some((field) => ctx[field] !== undefined && ctx[field] !== null);
      if (!hasFlatItemData) return [];
      return [{
        item_id: FLAT_ITEM_ID,
        product: ctx.product ?? null,
        quantity: ctx.quantity ?? null,
        measurements: ctx.measurements ?? null,
        catalog_ref: null,
        requested_label: null,
      }];
    }

    if (stored.length === 0) return stored;

    const flatNow = comparableProjection(ctx);
    const flatStored = comparableProjection(ctx.line_items_projection);
    const legacyWriterRan = JSON.stringify(flatNow) !== JSON.stringify(flatStored);
    if (!legacyWriterRan) return stored;

    const [primary, ...rest] = stored;
    return [{ ...primary, ...flatNow }, ...rest];
  };

  // D1: handles are fixed inside the immutable decision, so replay and
  // re-reads always derive the same id. A flat row's implicit item is always
  // the constant li_0, never hashed.
  const deriveItemId = (conversationId, turnId, handle) => {
    if (handle === undefined || handle === null || handle === '') return FLAT_ITEM_ID;
    const seed = [LINE_ITEM_VERSION, safe(conversationId), safe(turnId), safe(handle)].join('\u0000');
    return `li_${sha256(seed).slice(0, 12)}`;
  };

  // D2: the primary item is the first item in array order. product,
  // quantity and measurements mirror it into the flat compatibility fields,
  // and are deleted entirely once no item remains (never left as null).
  const projectFlat = (context, items) => {
    const result = { ...asObject(context) };
    const list = Array.isArray(items) ? items : [];
    if (list.length === 0) {
      delete result.product;
      delete result.quantity;
      delete result.measurements;
      return result;
    }
    const primary = asObject(list[0]);
    result.product = primary.product ?? null;
    result.quantity = primary.quantity ?? null;
    result.measurements = primary.measurements ?? null;
    return result;
  };

  const projectionOf = (items) => {
    const list = Array.isArray(items) ? items : [];
    const primary = asObject(list[0]);
    return {
      product: primary.product ?? null,
      quantity: primary.quantity ?? null,
      measurements: primary.measurements ?? null,
    };
  };

  // Mirrors `apply_v3_state_mutations` in SQL. Applies only the mutation
  // vocabulary the v3/v3.1 contract authorizes: unknown fields, the
  // `line_items*` system keys, and unsupported operations fail the whole
  // batch, just as the SQL function does.
  const reduceV3StateMutations = (context, mutations) => {
    const ctx = asObject(context);
    const mutationList = Array.isArray(mutations) ? mutations : [];

    for (const raw of mutationList) {
      const mutation = asObject(raw);
      if (mutation.operation === 'remove_item') continue;
      const field = mutation.field === undefined ? null : mutation.field;
      if (field === null || field === '' || String(field).startsWith('_')) {
        throw new Error('invalid v3 mutation field');
      }
      if (RESERVED_ITEM_KEYS.has(field)) {
        throw new Error('invalid v3 mutation field');
      }
      if ((mutation.operation !== 'set' && mutation.operation !== 'replace') || !('projected_value' in mutation)) {
        throw new Error('unsupported v3 mutation operation');
      }
    }

    const touchesItems = mutationList.some((raw) => {
      const mutation = asObject(raw);
      return mutation.operation === 'remove_item' || ITEM_FIELDS.includes(mutation.field);
    });

    if (!touchesItems && !Array.isArray(ctx.line_items)) {
      // Legacy-compatible path: byte-identical to the pre-item-aware
      // function. No line_items scaffolding is introduced for a quote that
      // never touches an item concept.
      const result = { ...ctx };
      for (const raw of mutationList) {
        const mutation = asObject(raw);
        result[mutation.field] = mutation.projected_value;
      }
      return result;
    }

    let items = readLineItems(ctx).map(cloneItem);
    const quoteLevel = { ...ctx };
    delete quoteLevel.line_items;
    delete quoteLevel.line_items_projection;
    delete quoteLevel.line_items_schema;

    for (const raw of mutationList) {
      const mutation = asObject(raw);
      if (mutation.operation === 'remove_item') {
        items = items.filter((item) => item.item_id !== mutation.item_id);
        continue;
      }
      const field = mutation.field;
      if (!ITEM_FIELDS.includes(field)) {
        quoteLevel[field] = mutation.projected_value;
        continue;
      }
      const itemId = mutation.item_id ?? items[0]?.item_id ?? FLAT_ITEM_ID;
      let item = items.find((entry) => entry.item_id === itemId);
      if (!item) {
        item = newItem(itemId);
        items.push(item);
      }
      item[field] = mutation.projected_value;
    }

    if (items.length > MAX_LINE_ITEMS) {
      throw new Error('line_items_limit_exceeded');
    }

    const flatContext = projectFlat(quoteLevel, items);
    return {
      ...flatContext,
      line_items: items,
      line_items_projection: projectionOf(items),
      line_items_schema: LINE_ITEM_SCHEMA,
    };
  };

  const hasValue = (value) => value !== undefined && value !== null
    && (typeof value !== 'string' || value.trim() !== '');

  // Byte-identical to `formatRequirementValue` in
  // wa-conversation-orchestrator/build-v3-lead-effect.js, so the single-item
  // requirement this composes never drifts from the legacy string.
  const formatFieldValue = (value) => {
    if (!hasValue(value)) return '';
    if (typeof value !== 'object' || Array.isArray(value)) return String(value).trim();
    const name = hasValue(value.name) ? String(value.name).trim() : '';
    const amount = hasValue(value.value) ? String(value.value).trim() : '';
    const unit = hasValue(value.unit) ? String(value.unit).trim() : '';
    const measurement = [amount, unit].filter(Boolean).join(' ');
    if (name || measurement) return [name, measurement].filter(Boolean).join(' ');
    return JSON.stringify(value);
  };

  // D9: one item keeps the exact legacy requirement string (product,
  // quantity, measurements, then the quote-level use_case, in that order). A
  // requirement without a product is never invented.
  const composeSingleItemRequirement = (item, useCase) => {
    const facts = asObject(item);
    if (!hasValue(facts.product)) return '';
    return [facts.product, facts.quantity, facts.measurements, useCase]
      .map(formatFieldValue)
      .filter(Boolean)
      .join(' ');
  };

  // D9: several items render one bullet line each, plus one Uso line for the
  // quote-level use_case when present.
  const composeMultiItemRequirement = (items, useCase) => {
    const lines = items.map((item) => {
      const facts = asObject(item);
      const product = formatFieldValue(facts.product);
      const quantity = formatFieldValue(facts.quantity);
      const measurements = formatFieldValue(facts.measurements);
      const head = `• ${product} — ${quantity}`;
      return measurements ? `${head}, ${measurements}` : head;
    });
    const useCaseLine = hasValue(useCase) ? [`Uso: ${formatFieldValue(useCase)}`] : [];
    return [...lines, ...useCaseLine].join('\n');
  };

  const composeRequirement = (items, quoteLevelFacts = {}) => {
    const list = Array.isArray(items) ? items : [];
    const useCase = asObject(quoteLevelFacts).use_case;
    if (list.length === 0) return '';
    if (list.length === 1) return composeSingleItemRequirement(list[0], useCase);
    return composeMultiItemRequirement(list, useCase);
  };

  return { readLineItems, deriveItemId, reduceV3StateMutations, projectFlat, composeRequirement };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { readLineItems, deriveItemId, reduceV3StateMutations, projectFlat, composeRequirement };
}
