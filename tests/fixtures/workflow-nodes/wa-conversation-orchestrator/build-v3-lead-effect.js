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

// PRD: "requerimiento suficientemente concreto". Compose it from the concrete
// facts the turn authorized, in the order the PRD lists them, and never invent
// one: below three fields the lead is refused on purpose.
const REQUIREMENT_FIELDS = ['product', 'quantity', 'measurements', 'use_case'];

const projectedMutations = (row) => {
  const mutations = Array.isArray(row.v3_decision?.state_mutations)
    ? row.v3_decision.state_mutations
    : [];
  const byField = {};
  for (const mutation of mutations) {
    if (!mutation || typeof mutation.field !== 'string') continue;
    const value = mutation.projected_value;
    if (value === undefined || value === null || String(value).trim() === '') continue;
    byField[mutation.field] = String(value).trim();
  }
  return byField;
};

const buildV3LeadEffect = (row) => {
  const projected = projectedMutations(row);
  const context = row.qualification_context ?? {};
  // A requirement has to name what is being asked for. Quantity or measures
  // alone are not "suficientemente concreto", and must not overwrite a complete
  // requirement an earlier turn already committed.
  const requirement = projected.product
    ? REQUIREMENT_FIELDS.map((field) => projected[field]).filter(Boolean).join(' ')
    : '';
  return ({
  ...row,
  operation_key: row.operation_key,
  source_number_id: row.source_number_id,
  phone_number: row.phone_number,
  external_contact_id: row.external_contact_id ?? null,
  whatsapp_name: row.whatsapp_name ?? null,
  service: MODALITY_SERVICE[projected.modality] ?? context.service ?? null,
  city: projected.commune ?? context.city ?? null,
  requirement: requirement || context.requirement || null,
  is_partial: false,
  conversation_id: row.conversation_id,
  qualification_context: row.qualification_context ?? {},
  qualification_context_json: JSON.stringify(row.qualification_context ?? {}),
  commercial_missing_fields: [],
  });
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { buildV3LeadEffect };
}

if (typeof items !== 'undefined') {
  return items.map((item) => ({ json: buildV3LeadEffect(item.json ?? {}) }));
}
