// The lead contract predates v3 and names its three required fields
// `service`, `city` and `requirement`. A v3 decision names its facts
// `product`, `commune`, `quantity` and `modality` — PRD section 25.1 lists
// exactly those four as the commercial fields — and carries them as projected
// mutations that are not committed to `qualification_context` until after this
// effect has already run. Reading the context alone left all three empty and
// `Prepare Lead Assignment` refused the lead.
//
// `service` holds the modality, not the product: the PRD product-vs-service
// rule says the only real services are instalacion, retiro de escombros,
// suministro and despacho. The labels below are the ones
// `resolveCommercialProfile` already uses in apply-ai-assistance.js.
const MODALITY_SERVICE = Object.freeze({
  installation: 'instalacion',
  delivery: 'despacho',
  pickup: 'retiro',
  material: 'material',
});
const SERVICE_SCOPE_SERVICE = Object.freeze({
  installation: 'instalacion',
  material: 'material',
  both: 'material e instalacion',
});
const FULFILLMENT_SERVICE = Object.freeze({
  delivery: 'despacho',
  pickup: 'retiro',
});

// D9 (design.md): the item-aware reducer and requirement composer are the
// single source of truth for both the flat single-item string (byte-identical
// to the pre-item-aware merge below) and the multi-item bullet rendering.
// Production Code nodes get shared/v3-line-items.js concatenated ahead of
// this file (tests/scripts/sync-workflow-nodes.mjs), so `reduceV3StateMutations`,
// `readLineItems` and `composeRequirement` are already outer free variables
// there, and `require` resolves no relative paths in that sandbox
// (docker-compose.yml: NODE_FUNCTION_ALLOW_BUILTIN). Node test harnesses
// `require` this file standalone, so the fallback below loads the sibling
// file directly in that environment only.
const externalLineItemsRuntime = (() => {
  if (typeof module === 'undefined' || typeof require !== 'function') return null;
  try {
    return require('../shared/v3-line-items.js');
  } catch (_error) {
    return null;
  }
})();
const resolvedReduceV3StateMutations = externalLineItemsRuntime
  ? externalLineItemsRuntime.reduceV3StateMutations
  : (typeof reduceV3StateMutations === 'function' ? reduceV3StateMutations : null);
const resolvedReadLineItems = externalLineItemsRuntime
  ? externalLineItemsRuntime.readLineItems
  : (typeof readLineItems === 'function' ? readLineItems : null);
const resolvedComposeRequirement = externalLineItemsRuntime
  ? externalLineItemsRuntime.composeRequirement
  : (typeof composeRequirement === 'function' ? composeRequirement : null);

const buildV3LeadEffect = (row) => {
  const context = row.qualification_context ?? {};
  const mutations = Array.isArray(row.v3_decision?.state_mutations)
    ? row.v3_decision.state_mutations
    : [];
  // reduce(context, decision.state_mutations): mirrors apply_v3_state_mutations
  // (SQL), so the facts this effect reads are the same facts the commit step
  // will persist. readLineItems then recovers the item list (dual-read: a
  // historical flat row becomes a single implicit item) for the composer.
  const reduced = resolvedReduceV3StateMutations(context, mutations);
  const items = resolvedReadLineItems(reduced);
  // A requirement has to name what is being asked for. Quantity or measures
  // alone are not "suficientemente concreto", and must not overwrite a complete
  // requirement an earlier turn already committed.
  const requirement = resolvedComposeRequirement(items, reduced);
  const legacyService = ['installation', 'both'].includes(reduced.service_scope)
    ? SERVICE_SCOPE_SERVICE[reduced.service_scope]
    : FULFILLMENT_SERVICE[reduced.fulfillment]
      ?? SERVICE_SCOPE_SERVICE[reduced.service_scope]
      ?? MODALITY_SERVICE[reduced.modality]
      ?? reduced.service
      ?? null;
  return ({
  ...row,
  operation_key: row.operation_key,
  source_number_id: row.source_number_id,
  phone_number: row.phone_number,
  external_contact_id: row.external_contact_id ?? null,
  whatsapp_name: row.whatsapp_name ?? null,
  service: legacyService,
  city: reduced.commune ?? reduced.city ?? null,
  requirement: requirement || context.requirement || null,
  is_partial: false,
  conversation_id: row.conversation_id,
  qualification_context: reduced,
  qualification_context_json: JSON.stringify(reduced),
  commercial_missing_fields: [],
  });
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { buildV3LeadEffect };
}

if (typeof items !== 'undefined') {
  return items.map((item) => ({ json: buildV3LeadEffect(item.json ?? {}) }));
}
