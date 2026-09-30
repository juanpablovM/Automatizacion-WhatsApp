const buildV3PolicyInput = (() => {
  const asObject = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const safe = (value, fallback = '') => String(value ?? fallback).trim();
const POLICY_FIELDS = [
  'name', 'product', 'service', 'commune', 'quantity', 'measurements', 'use_case',
  'service_scope', 'fulfillment', 'urgency', 'desired_date', 'terrain', 'truck_access',
  'debris_removal', 'customer_type', 'company', 'company_rut', 'contact_name',
  'contact_role', 'email', 'purchase_order', 'invoice_required', 'address',
  'access_restrictions', 'reception_contact', 'issue_description', 'payment_amount',
  'payment_method', 'quote_number',
];

const sanitizePriorRequest = (value) => {
  const source = asObject(value);
  const sourceValues = asObject(source.values);
  const values = {};
  for (const field of POLICY_FIELDS) {
    const candidate = sourceValues[field];
    if (candidate === undefined || candidate === null || safe(candidate) === '') continue;
    values[field] = candidate;
  }
  if (!Object.keys(values).length || !safe(source.lead_id)) return null;
  return {
    lead_id: safe(source.lead_id),
    source_conversation_id: safe(source.source_conversation_id) || null,
    completed_at: safe(source.completed_at) || null,
    lead_status_code: safe(source.lead_status_code) || null,
    values,
  };
};

const persistedPendingGoal = (value) => {
  const key = safe(value);
  if (!key) return null;
  return key === 'confirm' ? 'final_confirmation' : key;
};

// D1-D3 (design.md): the item-aware model is read through, not gated. A
// single-item flat row and an item-aware row with one matching item always
// derive the same primary-item fields, so this never changes today's v3
// output (tests/unit/v3-policy-builder-line-items-regression.test.js). Only
// v3.1 (Slice 2a) emits item facts, goals and authority beyond this primary
// item.
//
// Production Code nodes get shared/v3-line-items.js concatenated ahead of
// this file (tests/scripts/sync-workflow-nodes.mjs), so `readLineItems` is
// already an outer free variable there and `require` resolves no relative
// paths in that sandbox (docker-compose.yml: NODE_FUNCTION_ALLOW_BUILTIN).
// Node test harnesses `require` this file standalone, so the fallback below
// loads the sibling file directly in that environment only.
const externalLineItemsRuntime = (() => {
  if (typeof module === 'undefined' || typeof require !== 'function') return null;
  try {
    return require('./v3-line-items.js');
  } catch (_error) {
    return null;
  }
})();
const resolvedReadLineItems = externalLineItemsRuntime
  ? externalLineItemsRuntime.readLineItems
  : (typeof readLineItems === 'function' ? readLineItems : null);
// Task 3c.20: the relevance selection of technical sheets reuses the v3.1
// validator's product matcher (name or listed synonym, whole phrase, longest
// match), so "bloques de cemento" selects Bloques de Hormigón, not Cemento.
// Production Code nodes get shared/v3-contract-runtime.js concatenated ahead
// of this file, so the function is an outer free variable there; Node test
// harnesses load the sibling file instead, as for readLineItems above.
const externalContractRuntime = (() => {
  if (typeof module === 'undefined' || typeof require !== 'function') return null;
  try {
    return require('./v3-contract-runtime.js');
  } catch (_error) {
    return null;
  }
})();
const resolvedProductRefsMentioned = externalContractRuntime?.productRefsMentionedV31
  || (typeof productRefsMentionedV31 === 'function' ? productRefsMentionedV31 : null);

// Task 3c.20: catalog_items.metadata.technical_sheet (private data applied via scripts/catalog/technical-sheets.mjs) is far too
// large to send whole every turn. v3.1 keeps a compact sheet only for the
// products in the quote's line items and the products or services the current
// message names, and all selected sheets together stay within this many UTF-8
// bytes of JSON. Everything here is a pure function of the turn input, so the
// policy digest stays deterministic.
const TECHNICAL_SHEETS_MAX_BYTES = 6144;
const TECHNICAL_SHEET_VARIANT_KEYS = ['name', 'code', 'dimensions', 'weight', 'yield', 'resistance', 'colors', 'finishes', 'other'];
const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isEmptySheetValue = (value) => value === null || value === undefined
  || (typeof value === 'string' && value.trim() === '')
  || (Array.isArray(value) && value.length === 0)
  || (isPlainObject(value) && Object.keys(value).length === 0);
const jsonBytes = (value) => new TextEncoder().encode(JSON.stringify(value)).length;
// Only the agreed keys, without empty fields; source_files never reach the model.
const compactTechnicalSheet = (sheet) => {
  if (!isPlainObject(sheet)) return null;
  const compact = {};
  if (typeof sheet.description === 'string' && sheet.description.trim() !== '') compact.description = sheet.description.trim();
  if (isPlainObject(sheet.general_specs) && Object.keys(sheet.general_specs).length > 0) compact.general_specs = sheet.general_specs;
  const variants = (Array.isArray(sheet.variants) ? sheet.variants : [])
    .filter(isPlainObject)
    .map((variant) => Object.fromEntries(TECHNICAL_SHEET_VARIANT_KEYS
      .filter((key) => !isEmptySheetValue(variant[key]))
      .map((key) => [key, variant[key]])))
    .filter((variant) => Object.keys(variant).length > 0);
  if (variants.length > 0) compact.variants = variants;
  if (isPlainObject(sheet.unconfirmed) && Object.keys(sheet.unconfirmed).length > 0) compact.unconfirmed = sheet.unconfirmed;
  return Object.keys(compact).length > 0 ? compact : null;
};
// Drops trailing variants until the sheet fits, and says how many it dropped.
const fitTechnicalSheet = (sheet, budget) => {
  if (jsonBytes(sheet) <= budget) return sheet;
  const variants = sheet.variants || [];
  const { variants: _variants, ...base } = sheet;
  for (let kept = variants.length - 1; kept >= 0; kept -= 1) {
    const candidate = { ...base, ...(kept > 0 ? { variants: variants.slice(0, kept) } : {}), variants_omitted: variants.length - kept };
    if (jsonBytes(candidate) <= budget) return candidate;
  }
  const omitted = { omitted: true };
  return jsonBytes(omitted) <= budget ? omitted : null;
};
const phraseFoldForSheets = (value) => String(value ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLocaleLowerCase('es').replace(/[^a-z0-9]+/g, ' ').trim();
const lineItemProductText = (product) => (typeof product === 'string'
  ? product
  : (isPlainObject(product) ? String(product.value ?? product.name ?? '') : ''));
// Priority: line-item products first (item order), then what the message names
// (catalog order). The byte budget is shared by water-filling: smaller sheets
// are placed first and each sheet may use an equal share of what is left.
const selectTechnicalSheets = ({ catalog, rawSheets, messageText, lineItems }) => {
  const productEntries = catalog.filter((entry) => entry?.concept === 'product');
  const mentioned = (text) => (resolvedProductRefsMentioned && String(text ?? '').trim() !== ''
    ? resolvedProductRefsMentioned(productEntries, text)
    : new Set());
  const relevant = [];
  const addRef = (ref) => { if (rawSheets.has(ref) && !relevant.includes(ref)) relevant.push(ref); };
  for (const item of lineItems) {
    for (const ref of mentioned(lineItemProductText(item?.product))) addRef(ref);
  }
  const messageRefs = mentioned(messageText);
  const foldedMessage = ` ${phraseFoldForSheets(messageText)} `;
  for (const entry of catalog) {
    if (entry?.concept === 'product' && messageRefs.has(entry.ref)) addRef(entry.ref);
    if (entry?.concept === 'service' && typeof entry.value === 'string') {
      const needle = phraseFoldForSheets(entry.value);
      if (needle && foldedMessage.includes(` ${needle} `)) addRef(entry.ref);
    }
  }
  const candidates = relevant
    .map((ref, priority) => ({ ref, priority, sheet: compactTechnicalSheet(rawSheets.get(ref)) }))
    .filter((candidate) => candidate.sheet !== null)
    .map((candidate) => ({ ...candidate, size: jsonBytes(candidate.sheet) }))
    .sort((left, right) => left.size - right.size || left.priority - right.priority);
  const selected = new Map();
  let remaining = TECHNICAL_SHEETS_MAX_BYTES;
  candidates.forEach((candidate, index) => {
    const fitted = fitTechnicalSheet(candidate.sheet, Math.floor(remaining / (candidates.length - index)));
    if (!fitted) return;
    selected.set(candidate.ref, fitted);
    remaining -= jsonBytes(fitted);
  });
  return selected;
};

const primaryLineItem = (context) => {
  const items = resolvedReadLineItems ? resolvedReadLineItems(context) : [];
  return items[0] || {};
};
const ITEM_FACT_FIELDS = new Set(['product', 'quantity', 'measurements']);
const hasFieldValue = (value) => value !== undefined && value !== null && safe(value) !== '';

const buildV3PolicyInput = (row, options = {}) => {
  // Slice 2a (design.md D1-D5), dark: nothing in production requests
  // `version: 'v3.1'` until Slice 2b's switch. The default stays the exact
  // Slice 1 single-item read-through, byte-identical to today's output.
  const version = options?.version === 'v3.1' ? 'v3.1' : 'v3';
  const input = asObject(row);
  const context = asObject(input.qualification_context);
  const primaryItem = primaryLineItem(context);
  const explicitGrounding = asObject(input.v3_grounding);
  const commercialContext = asObject(input.commercial_context);
  const inputReferenceContext = asObject(input.reference_context);
  const priorRequest = sanitizePriorRequest(inputReferenceContext.prior_request);
  const legacyModality = context.modality;
  const legacyServiceScope = ['material', 'installation', 'both'].includes(legacyModality)
    ? legacyModality
    : ['pickup', 'delivery'].includes(legacyModality) ? 'material' : undefined;
  const legacyFulfillment = ['pickup', 'delivery'].includes(legacyModality)
    ? legacyModality
    : undefined;
  const catalogItems = Array.isArray(commercialContext.catalog_items) ? commercialContext.catalog_items : [];
  const refPart = (value) => safe(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const derivedCatalog = [];
  for (const item of catalogItems) {
    const name = safe(item?.name);
    if (!name) continue;
    const concept = safe(item?.item_type).toLowerCase() === 'service' ? 'service' : 'product';
    derivedCatalog.push({ ref: `${concept}:${refPart(item.id || item.sku || name)}`, concept, value: name });
  }
  const canonicalModalitySynonyms = [
    { ref: 'service_scope:material', concept: 'service_scope', value: 'material' },
    { ref: 'service_scope:installation', concept: 'service_scope', value: 'installation' },
    { ref: 'service_scope:both', concept: 'service_scope', value: 'both' },
    { ref: 'fulfillment:delivery', concept: 'fulfillment', value: 'delivery' },
    { ref: 'fulfillment:pickup', concept: 'fulfillment', value: 'pickup' },
  ];
  const modalitySynonyms = [
    ...(Array.isArray(explicitGrounding.modality_synonyms) ? explicitGrounding.modality_synonyms : []),
    ...canonicalModalitySynonyms,
  ].filter((entry, index, entries) => entry?.ref
    && entries.findIndex((candidate) => candidate?.ref === entry.ref) === index);
  // Task 3c.19: catalog entries may carry optional `synonyms` (migration 026).
  // v3.1 keeps them sanitized (distinct, trimmed, non-empty strings; the key
  // is dropped when none survive). v3, the rollback path, never carries the
  // key, so its policy stays identical to the pre-synonyms one.
  // Task 3c.20: the same holds for the optional `technical_sheet` (private
  // catalog data): it is always removed here and v3.1 re-attaches a compact, capped
  // sheet only to the entries selected for this turn (selectTechnicalSheets).
  const catalogEntryForVersion = (entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
    if (!('synonyms' in entry) && !('technical_sheet' in entry)) return entry;
    const { synonyms, technical_sheet: _technicalSheet, ...rest } = entry;
    if (version !== 'v3.1' || !Array.isArray(synonyms)) return rest;
    const kept = [...new Set(synonyms.filter((synonym) => typeof synonym === 'string').map((synonym) => synonym.trim()))]
      .filter((synonym) => synonym !== '');
    return kept.length > 0 ? { ...rest, synonyms: kept } : rest;
  };
  const sourceCatalog = [
    ...(Array.isArray(explicitGrounding.catalog) ? explicitGrounding.catalog : []),
    ...derivedCatalog,
  ].filter((entry) => entry?.concept !== 'commune');
  const versionedCatalog = sourceCatalog.map(catalogEntryForVersion);
  let catalog = versionedCatalog;
  if (version === 'v3.1') {
    const rawSheets = new Map();
    for (const entry of sourceCatalog) {
      if (isPlainObject(entry) && typeof entry.ref === 'string' && isPlainObject(entry.technical_sheet)
        && !rawSheets.has(entry.ref)) rawSheets.set(entry.ref, entry.technical_sheet);
    }
    if (rawSheets.size > 0) {
      const selected = selectTechnicalSheets({
        catalog: versionedCatalog,
        rawSheets,
        messageText: safe(input.text_body ?? input.message_current),
        lineItems: resolvedReadLineItems ? resolvedReadLineItems(context) : [],
      });
      const attached = new Set();
      catalog = versionedCatalog.map((entry) => {
        if (!isPlainObject(entry) || !selected.has(entry.ref) || attached.has(entry.ref)) return entry;
        attached.add(entry.ref);
        return { ...entry, technical_sheet: selected.get(entry.ref) };
      });
    }
  }
  const grounding = {
    catalog,
    modality_synonyms: modalitySynonyms,
  };
  const facts = [];
  const goals = [];
  const allowedMutations = [];
  const scope = context.service_scope ?? legacyServiceScope;
  const fulfillment = context.fulfillment ?? legacyFulfillment;
  const requiredGoals = new Set(['product', 'quantity', 'service_scope']);
  if (scope === 'material' || scope === 'both') requiredGoals.add('fulfillment');
  if (scope === 'installation' || scope === 'both') {
    for (const field of ['commune', 'address', 'terrain', 'truck_access', 'debris_removal']) requiredGoals.add(field);
  }
  if (fulfillment === 'delivery') {
    requiredGoals.add('commune');
    requiredGoals.add('address');
    requiredGoals.add('access_restrictions');
  }
  // A company is an ordinary lead. The advisor's terminal goal is handing the
  // quote to a seller, and the seller categorises the customer afterwards, so
  // no company-shaped field gates `create_lead`. Requiring a purchase order was
  // a deadlock in particular: that document only exists after a quote, which
  // only exists after the handoff this effect produces.
  let previousMetadata = asObject(input.metadata_json);
  if (typeof input.metadata_json === 'string') {
    try { previousMetadata = asObject(JSON.parse(input.metadata_json)); } catch (_error) { /* No prior retry evidence. */ }
  }
  const previousPending = safe(input.previous_commercial_pending_question_key
    ?? previousMetadata.previous_commercial_pending_question_key
    ?? previousMetadata.pending_question_key);
  const previousRetry = Math.max(0, Number(input.previous_commercial_question_retry
    ?? previousMetadata.previous_commercial_question_retry
    ?? previousMetadata.commercial_question_retry) || 0);
  const sameAddressPending = safe(input.pending_question_key) === 'address' && previousPending === 'address';
  const nextAddressRetry = sameAddressPending ? previousRetry + 1 : 0;
  for (const field of POLICY_FIELDS) {
    // v3.1 emits these three as per-item facts/authority below instead of a
    // single flat quote-level entry.
    if (version === 'v3.1' && ITEM_FACT_FIELDS.has(field)) continue;
    const compatibilityValue = field === 'service_scope'
      ? legacyServiceScope
      : field === 'fulfillment' ? legacyFulfillment : undefined;
    // A v3 fact must come from committed conversation state. Direct fields on
    // the workflow item are legacy heuristics for the current turn and have no
    // evidence lineage; treating them as facts produced values such as
    // "Perfecto" and "Domicilio" in the service field.
    const value = (ITEM_FACT_FIELDS.has(field) ? primaryItem[field] : context[field]) ?? compatibilityValue;
    const hasValue = value !== undefined && value !== null && safe(value) !== '';
    const factId = hasValue ? `fact:${field}` : null;
    if (hasValue) {
      facts.push({
        fact_id: factId,
        field,
        value,
        mutability: 'customer_correctable',
        source: { message_id: safe(input.last_message_id), evidence_digest: safe(input.last_evidence_digest) },
      });
    }
    goals.push({
      goal_id: field,
      status: hasValue ? 'resolved' : 'unresolved',
      importance: requiredGoals.has(field) ? 'required_for_effect' : 'optional',
      blocks_effects: requiredGoals.has(field) ? ['create_lead'] : [],
      ...(field === 'address' ? { guidance: {
        known_commune: safe(context.commune) || null,
        question_focus: 'street_and_approximate_number',
        commune_alone_is_not_address: true,
        previous_retry_count: previousRetry,
        next_retry_count_without_progress: nextAddressRetry,
        clarify_at: 2,
        handoff_at: 3,
        next_action_without_progress: nextAddressRetry >= 3 ? 'handoff' : nextAddressRetry >= 2 ? 'clarify' : 'ask',
        reset_retry_on_new_commercial_evidence: true,
      } } : {}),
    });
    // A shadow turn is a rehearsal, and a rehearsal with the authority removed
    // is not a rehearsal of anything: the model reads the customer correctly,
    // proposes recording what it read, and is refused for exceeding an authority
    // that was emptied for it alone. What keeps a shadow turn from touching
    // production is the lane, not the policy — `planShadowEvaluation` sets
    // allow_mutations/allow_effects false, the payload ships empty mutation and
    // effect arrays, and the evaluator has no effect executor or commit wired.
    allowedMutations.push(hasValue
      ? { operation: 'replace', concept: field, field, current_fact_id: factId }
      : { operation: 'set', concept: field, field });
  }

  if (version === 'v3.1') {
    const lineItems = resolvedReadLineItems ? resolvedReadLineItems(context) : [];
    for (const item of lineItems) {
      for (const field of ITEM_FACT_FIELDS) {
        const value = item?.[field];
        if (!hasFieldValue(value)) continue;
        facts.push({
          fact_id: `fact:item:${item.item_id}:${field}`,
          field,
          value,
          mutability: 'customer_correctable',
          source: { message_id: safe(input.last_message_id), evidence_digest: safe(input.last_evidence_digest) },
        });
      }
    }
    const lineItemsResolved = lineItems.length >= 1 && lineItems.length <= 10
      && lineItems.every((item) => hasFieldValue(item?.product) && hasFieldValue(item?.quantity));
    requiredGoals.delete('product');
    requiredGoals.delete('quantity');
    requiredGoals.add('line_items');
    goals.push({
      goal_id: 'line_items',
      status: lineItemsResolved ? 'resolved' : 'unresolved',
      importance: 'required_for_effect',
      blocks_effects: ['create_lead'],
    });
    for (const field of ITEM_FACT_FIELDS) {
      allowedMutations.push({ operation: 'set', concept: field, field });
      allowedMutations.push({ operation: 'replace', concept: field, field });
    }
    allowedMutations.push({ operation: 'remove_item', concept: 'line_items', field: null });
  }

  return {
    version,
    turn: {
      id: safe(input.inbound_event_id ?? input.turn_id),
      conversation_id: safe(
        input.route_conversation_id
          ?? input.conversation_id
          ?? input.target_conversation_id,
      ),
      conversation_revision: Number(input.conversation_revision || 0),
      // Pending-question authority is persisted independently from the legacy
      // step evaluator. `current_step` may describe what that evaluator inferred
      // from the message being processed, so reading it here makes a fresh turn
      // look like it is answering a question that was never asked.
      pending_question_goal_id: persistedPendingGoal(input.pending_question_key),
      message: {
        id: safe(input.external_message_id ?? input.inbound_event_id),
        text: safe(input.text_body ?? input.message_current),
      },
    },
    history: { messages: Array.isArray(input.recent_messages) ? input.recent_messages : [], truncated: false },
    reference_context: { prior_request: priorRequest },
    facts,
    goals,
    allowed_mutations: allowedMutations,
    grounding,
    claim_rules: [
      { rule_id: 'no_stock_confirmation', kind: 'forbidden_pattern', pattern: '\\bstock\\s+(confirmado|disponible)\\b', flags: 'iu' },
      { rule_id: 'no_unreceipted_derivation', kind: 'forbidden_pattern', pattern: '\\b(ya|quedo)\\s+derivad[oa]\\b', flags: 'iu' },
      { rule_id: 'no_unreceipted_quote_progress', kind: 'forbidden_pattern', pattern: '\\b(?:(?:estoy|estamos|seguimos)\\s+(?:procesando|gestionando)\\s+(?:tu|la)\\s+cotizaci[oó]n|(?:tu|la)\\s+cotizaci[oó]n\\s+(?:ya\\s+)?(?:est[aá]|qued[oó])\\s+en\\s+proceso)\\b', flags: 'iu' },
      { rule_id: 'no_unreceipted_delivery_progress', kind: 'forbidden_pattern', pattern: '\\b(?:recibas|recibir[aá]s)\\s+tu\\s+material\\s+pronto\\b', flags: 'iu' },
    ],
    effect_permissions: [{ type: 'create_lead' }, { type: 'handoff' }],
    effect_requirements: [
      {
        effect_type: 'create_lead',
        required_goal_ids: [...requiredGoals],
        trigger: 'explicit_confirmation_when_ready',
      },
      { effect_type: 'handoff', required_goal_ids: [] },
    ],
  };
};


  return buildV3PolicyInput;
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { buildV3PolicyInput };
}
