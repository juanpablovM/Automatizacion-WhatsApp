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
// The catalog refs relevant to this turn, in priority order: line-item
// products first (item order), then what the message names (catalog order).
const relevantCatalogRefs = ({ catalog, messageText, lineItems }) => {
  const productEntries = catalog.filter((entry) => entry?.concept === 'product');
  const mentioned = (text) => (resolvedProductRefsMentioned && String(text ?? '').trim() !== ''
    ? resolvedProductRefsMentioned(productEntries, text)
    : new Set());
  const relevant = [];
  const addRef = (ref) => { if (!relevant.includes(ref)) relevant.push(ref); };
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
  return relevant;
};
const selectTechnicalSheets = ({ catalog, rawSheets, messageText, lineItems, maxBytes = TECHNICAL_SHEETS_MAX_BYTES }) => {
  const relevant = relevantCatalogRefs({ catalog, messageText, lineItems }).filter((ref) => rawSheets.has(ref));
  const candidates = relevant
    .map((ref, priority) => ({ ref, priority, sheet: compactTechnicalSheet(rawSheets.get(ref)) }))
    .filter((candidate) => candidate.sheet !== null)
    .map((candidate) => ({ ...candidate, size: jsonBytes(candidate.sheet) }))
    .sort((left, right) => left.size - right.size || left.priority - right.priority);
  const selected = new Map();
  let remaining = maxBytes;
  candidates.forEach((candidate, index) => {
    const fitted = fitTechnicalSheet(candidate.sheet, Math.floor(remaining / (candidates.length - index)));
    if (!fitted) return;
    selected.set(candidate.ref, fitted);
    remaining -= jsonBytes(fitted);
  });
  return selected;
};

// Task 3c.29: technical-sheet PDFs (table technical_sheet_files, private rows)
// reach v3.1 as refs only: `technical_sheet_files: [{ref, variant, covers?,
// sent?, offered?}]` on the relevant catalog entries. `covers` (the variants a
// general sheet describes) is kept only for a general sheet (variant null);
// `sent` marks a sheet already sent in this conversation and `offered` the one
// the previous turn offered (pending question technical_sheet_offer), whose
// entry stays exposed even when the answer ("sí") names nothing. The refs come
// out of the same byte cap as the sheets: they may use up to
// TECHNICAL_SHEET_FILES_MAX_BYTES, and the sheets get what is left.
const TECHNICAL_SHEET_OFFER_GOAL = 'technical_sheet_offer';
const TECHNICAL_SHEET_FILES_MAX_BYTES = 3072;
const SHEET_REF = /^sheet:[a-z0-9-]+$/;
const sanitizeSheetFiles = (value) => (Array.isArray(value) ? value : [])
  .filter((file) => isPlainObject(file) && typeof file.ref === 'string' && SHEET_REF.test(file.ref)
    && (file.variant === null || (typeof file.variant === 'string' && file.variant.trim() !== '')))
  .map((file) => {
    const covers = Array.isArray(file.covers) ? file.covers.filter((name) => typeof name === 'string' && name.trim() !== '') : [];
    return { ref: file.ref, variant: file.variant, ...(file.variant === null && covers.length > 0 ? { covers } : {}) };
  })
  .filter((file, index, files) => files.findIndex((candidate) => candidate.ref === file.ref) === index);
const selectTechnicalSheetFiles = ({ catalog, rawFiles, relevantRefs, sentRefs, offerRef }) => {
  const offerEntryRef = offerRef
    ? [...rawFiles.keys()].find((ref) => rawFiles.get(ref).some((file) => file.ref === offerRef)) ?? null
    : null;
  const ordered = [...(offerEntryRef ? [offerEntryRef] : []), ...relevantRefs]
    .filter((ref, index, refs) => rawFiles.has(ref) && refs.indexOf(ref) === index);
  const rank = (file) => (file.ref === offerRef ? 0 : (file.variant === null ? 1 : 2));
  const selected = new Map();
  let used = 0;
  for (const catalogRef of ordered) {
    const files = rawFiles.get(catalogRef)
      .map((file, index) => ({ file, index }))
      .sort((left, right) => rank(left.file) - rank(right.file) || left.index - right.index)
      .map(({ file }) => ({
        ...file,
        ...(sentRefs.has(file.ref) ? { sent: true } : {}),
        ...(file.ref === offerRef ? { offered: true } : {}),
      }));
    const kept = [];
    for (const file of files) {
      if (used - (kept.length > 0 ? jsonBytes(kept) : 0) + jsonBytes([...kept, file]) > TECHNICAL_SHEET_FILES_MAX_BYTES) break;
      used += jsonBytes([...kept, file]) - (kept.length > 0 ? jsonBytes(kept) : 0);
      kept.push(file);
    }
    if (kept.length > 0) selected.set(catalogRef, { files: kept, omitted: files.length - kept.length });
  }
  return { selected, used };
};

const primaryLineItem = (context) => {
  const items = resolvedReadLineItems ? resolvedReadLineItems(context) : [];
  return items[0] || {};
};
const ITEM_FACT_FIELDS = new Set(['product', 'quantity', 'measurements']);
// Task 3c.33 (M1): v3.1 items also carry the chosen technical-sheet variant.
const V31_ITEM_FACT_FIELDS = [...ITEM_FACT_FIELDS, 'variant'];
const hasFieldValue = (value) => value !== undefined && value !== null && safe(value) !== '';
// Task 3c.33 (M3): a bare number ("33", or {value: 33, unit: null}) is not a
// resolved quantity. Mirrors isUnitlessQuantityV31 in v3-contract-runtime.js.
const hasQuantityWithUnit = (value) => {
  if (!hasFieldValue(value)) return false;
  if (typeof value === 'number') return false;
  if (typeof value === 'string') return !/^\s*\d+(?:[.,]\d+)?\s*$/.test(value);
  if (isPlainObject(value) && hasFieldValue(value.value) && /^\s*\d+(?:[.,]\d+)?\s*$/.test(String(value.value))) {
    return hasFieldValue(value.unit);
  }
  return true;
};

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
  // Task 3c.29: so does `technical_sheet_files` (refs of the sheet PDFs); v3.1
  // re-attaches them only to the relevant entries (selectTechnicalSheetFiles).
  const catalogEntryForVersion = (entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
    if (!('synonyms' in entry) && !('technical_sheet' in entry) && !('technical_sheet_files' in entry)) return entry;
    const { synonyms, technical_sheet: _technicalSheet, technical_sheet_files: _sheetFiles, ...rest } = entry;
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
  let technicalSheetFilesExposed = false;
  if (version === 'v3.1') {
    const turnMessageText = safe(input.text_body ?? input.message_current);
    const turnLineItems = resolvedReadLineItems ? resolvedReadLineItems(context) : [];
    const rawFiles = new Map();
    for (const entry of sourceCatalog) {
      if (!isPlainObject(entry) || typeof entry.ref !== 'string' || rawFiles.has(entry.ref)) continue;
      const files = sanitizeSheetFiles(entry.technical_sheet_files);
      if (files.length > 0) rawFiles.set(entry.ref, files);
    }
    const sentRefs = new Set((Array.isArray(explicitGrounding.technical_sheets_sent) ? explicitGrounding.technical_sheets_sent : [])
      .filter((ref) => typeof ref === 'string' && SHEET_REF.test(ref)));
    const offerRef = persistedPendingGoal(input.pending_question_key) === TECHNICAL_SHEET_OFFER_GOAL
      && typeof explicitGrounding.technical_sheet_offer_ref === 'string'
      && SHEET_REF.test(explicitGrounding.technical_sheet_offer_ref)
      ? explicitGrounding.technical_sheet_offer_ref
      : null;
    const sheetFiles = rawFiles.size > 0
      ? selectTechnicalSheetFiles({
        catalog: versionedCatalog,
        rawFiles,
        relevantRefs: relevantCatalogRefs({ catalog: versionedCatalog, messageText: turnMessageText, lineItems: turnLineItems }),
        sentRefs,
        offerRef,
      })
      : { selected: new Map(), used: 0 };
    technicalSheetFilesExposed = sheetFiles.selected.size > 0;
    const rawSheets = new Map();
    for (const entry of sourceCatalog) {
      if (isPlainObject(entry) && typeof entry.ref === 'string' && isPlainObject(entry.technical_sheet)
        && !rawSheets.has(entry.ref)) rawSheets.set(entry.ref, entry.technical_sheet);
    }
    if (rawSheets.size > 0 || technicalSheetFilesExposed) {
      const selected = rawSheets.size > 0
        ? selectTechnicalSheets({
          catalog: versionedCatalog,
          rawSheets,
          messageText: turnMessageText,
          lineItems: turnLineItems,
          maxBytes: TECHNICAL_SHEETS_MAX_BYTES - sheetFiles.used,
        })
        : new Map();
      const attached = new Set();
      catalog = versionedCatalog.map((entry) => {
        if (!isPlainObject(entry) || attached.has(entry.ref)
          || (!selected.has(entry.ref) && !sheetFiles.selected.has(entry.ref))) return entry;
        attached.add(entry.ref);
        const files = sheetFiles.selected.get(entry.ref);
        return {
          ...entry,
          ...(selected.has(entry.ref) ? { technical_sheet: selected.get(entry.ref) } : {}),
          ...(files ? { technical_sheet_files: files.files } : {}),
          ...(files && files.omitted > 0 ? { technical_sheet_files_omitted: files.omitted } : {}),
        };
      });
    }
    // Task 3c.26: `Load Conversation State` lists the products the customer
    // removed from this quote (v3_grounding.removed_products, from committed
    // remove_item turns). v3.1 marks those catalog entries so the model and
    // the validator know not to re-add them; a product that is back in the
    // quote is not marked. Without removals no entry changes, so the policy
    // and its digest are the same as before. v3 never reads the list.
    const removedProducts = Array.isArray(explicitGrounding.removed_products)
      ? explicitGrounding.removed_products.filter((name) => typeof name === 'string')
      : [];
    if (removedProducts.length > 0) {
      const foldName = (value) => String(value ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '')
        .toLocaleLowerCase('es').replace(/\s+/g, ' ').trim();
      const inQuote = new Set((resolvedReadLineItems ? resolvedReadLineItems(context) : [])
        .map((item) => foldName(lineItemProductText(item?.product))));
      const removed = new Set(removedProducts.map(foldName).filter((name) => name !== '' && !inQuote.has(name)));
      catalog = catalog.map((entry) => (isPlainObject(entry) && entry.concept === 'product'
        && typeof entry.value === 'string' && removed.has(foldName(entry.value))
        ? { ...entry, removed_by_customer: true }
        : entry));
    }
    // Task 3c.33 (M2): a quoted (or named) product whose technical sheet lists
    // two or more variants exposes their names as `variant_options`, outside
    // the technical-sheet byte cap, so the customer's choice can be asked and
    // validated before final_confirmation. A product with one variant or none
    // carries no key, so its policy is unchanged.
    const variantRefs = relevantCatalogRefs({
      catalog: versionedCatalog,
      messageText: turnMessageText,
      lineItems: turnLineItems,
    });
    const variantOptionsByRef = new Map();
    for (const entry of sourceCatalog) {
      if (!isPlainObject(entry) || typeof entry.ref !== 'string' || !variantRefs.includes(entry.ref)
        || variantOptionsByRef.has(entry.ref) || !isPlainObject(entry.technical_sheet)) continue;
      const options = [...new Set((Array.isArray(entry.technical_sheet.variants) ? entry.technical_sheet.variants : [])
        .map((variant) => (isPlainObject(variant) && typeof variant.name === 'string' ? variant.name.trim() : ''))
        .filter(Boolean))];
      if (options.length >= 2) variantOptionsByRef.set(entry.ref, options);
    }
    if (variantOptionsByRef.size > 0) {
      catalog = catalog.map((entry) => (isPlainObject(entry) && variantOptionsByRef.has(entry.ref)
        && !('variant_options' in entry)
        ? { ...entry, variant_options: variantOptionsByRef.get(entry.ref) }
        : entry));
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
  // Task 3c.24 (v3.1 only): installation is only offered with delivery
  // (owner rule, 3c.12), so with installation in scope fulfillment is never a
  // goal to ask. v3, the rollback path, keeps its exact policy.
  if (version === 'v3.1' && (scope === 'installation' || scope === 'both')) requiredGoals.delete('fulfillment');
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
      for (const field of V31_ITEM_FACT_FIELDS) {
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
    // Task 3c.33: an item resolves only with a quantity that carries a unit
    // (M3) and, when its product lists several variants, a chosen variant (M2).
    const foldProduct = (value) => String(value ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '')
      .toLocaleLowerCase('es').replace(/\s+/g, ' ').trim();
    const needsVariant = (product) => catalog.some((entry) => isPlainObject(entry) && entry.concept === 'product'
      && Array.isArray(entry.variant_options) && entry.variant_options.length >= 2
      && foldProduct(entry.value) !== '' && foldProduct(entry.value) === foldProduct(lineItemProductText(product)));
    const lineItemsResolved = lineItems.length >= 1 && lineItems.length <= 10
      && lineItems.every((item) => hasFieldValue(item?.product) && hasQuantityWithUnit(item?.quantity)
        && (!needsVariant(item?.product) || hasFieldValue(item?.variant)));
    requiredGoals.delete('product');
    requiredGoals.delete('quantity');
    requiredGoals.add('line_items');
    goals.push({
      goal_id: 'line_items',
      status: lineItemsResolved ? 'resolved' : 'unresolved',
      importance: 'required_for_effect',
      blocks_effects: ['create_lead'],
    });
    for (const field of V31_ITEM_FACT_FIELDS) {
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
      // Task 3c.33 (L1, v3.1 only): internal documents are never named to the
      // customer (live 2026-09-30: "fichas editables", "la ficha disponible").
      // The customer-facing technical sheet ("ficha técnica") stays allowed.
      ...(version === 'v3.1' ? [{
        rule_id: 'no_internal_documents',
        kind: 'forbidden_pattern',
        pattern: '\\bfichas?\\s+(?:editables?|disponibles?|internas?)\\b|\\b[\\w-]+\\.(?:pdf|docx?|xlsx?|csv)\\b',
        flags: 'iu',
      }] : []),
    ],
    // Task 3c.29: v3.1 may send a technical-sheet PDF only when the policy
    // exposes at least one; otherwise the permission is absent.
    effect_permissions: [
      { type: 'create_lead' }, { type: 'handoff' },
      ...(technicalSheetFilesExposed ? [{ type: 'send_technical_sheet' }] : []),
    ],
    effect_requirements: [
      {
        effect_type: 'create_lead',
        required_goal_ids: [...requiredGoals],
        trigger: 'explicit_confirmation_when_ready',
      },
      { effect_type: 'handoff', required_goal_ids: [] },
      ...(technicalSheetFilesExposed ? [{ effect_type: 'send_technical_sheet', required_goal_ids: [] }] : []),
    ],
  };
};


  return buildV3PolicyInput;
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { buildV3PolicyInput };
}
