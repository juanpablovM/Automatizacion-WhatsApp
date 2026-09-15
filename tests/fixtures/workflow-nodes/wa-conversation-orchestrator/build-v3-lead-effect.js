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

// PRD: "requerimiento suficientemente concreto". Compose it from the concrete
// facts the turn authorized, in the order the PRD lists them, and never invent
// one: below three fields the lead is refused on purpose.
const REQUIREMENT_FIELDS = ['product', 'quantity', 'measurements', 'use_case'];

const hasValue = (value) => value !== undefined
  && value !== null
  && (typeof value !== 'string' || value.trim() !== '');

const formatRequirementValue = (value) => {
  if (!hasValue(value)) return '';
  if (typeof value !== 'object' || Array.isArray(value)) return String(value).trim();
  const name = hasValue(value.name) ? String(value.name).trim() : '';
  const amount = hasValue(value.value) ? String(value.value).trim() : '';
  const unit = hasValue(value.unit) ? String(value.unit).trim() : '';
  const measurement = [amount, unit].filter(Boolean).join(' ');
  if (name || measurement) return [name, measurement].filter(Boolean).join(' ');
  return JSON.stringify(value);
};

const projectedMutations = (row) => {
  const mutations = Array.isArray(row.v3_decision?.state_mutations)
    ? row.v3_decision.state_mutations
    : [];
  const byField = {};
  for (const mutation of mutations) {
    if (!mutation || typeof mutation.field !== 'string') continue;
    const value = mutation.projected_value;
    if (!hasValue(value)) continue;
    byField[mutation.field] = value;
  }
  return byField;
};

const buildV3LeadEffect = (row) => {
  const projected = projectedMutations(row);
  const context = row.qualification_context ?? {};
  const facts = { ...context, ...projected };
  // A requirement has to name what is being asked for. Quantity or measures
  // alone are not "suficientemente concreto", and must not overwrite a complete
  // requirement an earlier turn already committed.
  const requirement = facts.product
    ? REQUIREMENT_FIELDS.map((field) => formatRequirementValue(facts[field])).filter(Boolean).join(' ')
    : '';
  const legacyService = ['installation', 'both'].includes(facts.service_scope)
    ? SERVICE_SCOPE_SERVICE[facts.service_scope]
    : FULFILLMENT_SERVICE[facts.fulfillment]
      ?? SERVICE_SCOPE_SERVICE[facts.service_scope]
      ?? MODALITY_SERVICE[facts.modality]
      ?? facts.service
      ?? null;
  return ({
  ...row,
  operation_key: row.operation_key,
  source_number_id: row.source_number_id,
  phone_number: row.phone_number,
  external_contact_id: row.external_contact_id ?? null,
  whatsapp_name: row.whatsapp_name ?? null,
  service: legacyService,
  city: facts.commune ?? facts.city ?? null,
  requirement: requirement || context.requirement || null,
  is_partial: false,
  conversation_id: row.conversation_id,
  qualification_context: facts,
  qualification_context_json: JSON.stringify(facts),
  commercial_missing_fields: [],
  });
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { buildV3LeadEffect };
}

if (typeof items !== 'undefined') {
  return items.map((item) => ({ json: buildV3LeadEffect(item.json ?? {}) }));
}
