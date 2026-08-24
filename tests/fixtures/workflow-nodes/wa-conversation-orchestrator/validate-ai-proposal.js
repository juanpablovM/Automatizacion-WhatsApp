const asObject = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const asArray = (value) => Array.isArray(value) ? value : [];
const safe = (value, fallback = '') => String(value ?? fallback).trim();
const error = (code, path, detail = null) => ({ code, path, detail });
const AI_RESULT_FIELDS = [
  'ai_skipped', 'ai_skip_reason', 'ai_provider', 'ai_model', 'ai_api_mode',
  'ai_status_code', 'ai_retry_attempts', 'ai_retry_exhausted', 'ai_parse_error',
  'ai_request_error', 'ai_fallback_reason', 'ai_proposal', 'reply_text',
];

const normalizeSemanticMergeRow = (row = {}) => {
  const entries = Object.entries(asObject(row));
  const normalized = Object.fromEntries(entries.filter(([key]) => !/_[12]$/.test(key)));
  const assistantMetadata = row.metadata_json ?? row.metadata_json_2 ?? null;

  for (const [key, value] of entries) {
    if (key.endsWith('_1')) normalized[key.slice(0, -2)] = value;
  }
  for (const field of AI_RESULT_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(row, field)) normalized[field] = row[field];
    else if (Object.prototype.hasOwnProperty.call(row, `${field}_2`)) normalized[field] = row[`${field}_2`];
  }
  if (assistantMetadata !== null && assistantMetadata !== undefined) {
    normalized.semantic_ai_metadata_json = assistantMetadata;
  }
  return normalized;
};

const utf8Slice = (text, start, end) => {
  const bytes = typeof Buffer !== 'undefined'
    ? Buffer.from(String(text), 'utf8')
    : new TextEncoder().encode(String(text));
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > bytes.length) return null;
  if (typeof Buffer !== 'undefined') return bytes.subarray(start, end).toString('utf8');
  return new TextDecoder().decode(bytes.slice(start, end));
};

// <generated:prd-validators>
const hasAuthorizedPriceContext = (priceContext) => {
  const context = asObject(priceContext);
  if (!['fixed', 'reference', 'from', 'range'].includes(context.type)) return false;
  return [context.amount, context.amount_min, context.amount_max]
    .some((value) => Number.isFinite(Number(value)));
};

const normalizePrdClaimText = (value) => String(value ?? '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase();

const PRD_VALIDATORS = [
  {
    name: 'NO_INVENT_PRICE',
    test: (text, _catalogMatches, priceContext) => {
      const hasPrice = /\$\s*[\d.,]+/.test(text);
      const hasOfficial = hasAuthorizedPriceContext(priceContext);
      return hasPrice && !hasOfficial;
    },
    fallback: 'Para darte un valor correcto necesito revisar producto, cantidad, comuna y si buscas solo material, despacho o instalacion. Te ayudo con esos datos y te derivo para cotizacion.',
  },
  {
    name: 'NO_CONFIRM_STOCK',
    test: (text) => /\b(tenemos stock|stock disponible|hay disponibilidad|esta disponible|en stock)\b/i.test(text)
      && /\b(baldosas?|pastelones?|adocretos?|cierres?|bloques?|soleras?|placas?|postes?)\b/i.test(text),
    semanticTest: (text) => /\b(tenemos stock|stock disponible|hay disponibilidad|esta disponible|en stock)\b/i
      .test(normalizePrdClaimText(text)),
    fallback: 'Puedo levantar tu solicitud, pero la disponibilidad debe confirmarla el equipo antes de cerrar la venta.',
  },
  {
    name: 'NO_CONFIRM_PAYMENT',
    test: (text) => /\b(pago confirmado|transferencia recibida|ya puedes retirar|ya esta validado|pago acreditado)\b/i.test(text),
    semanticTest: (text) => /\b(pago(?: fue)? confirmado|transferencia recibida|ya puedes retirar|ya esta validado|pago acreditado)\b/i
      .test(normalizePrdClaimText(text)),
    fallback: 'Recibimos el comprobante. La validacion final del pago la realiza Finanzas una vez que el monto este acreditado. Te avisaremos cuando quede confirmado.',
  },
  {
    name: 'NO_DISCOUNT',
    test: (text) => /\b(te puedo hacer\s+\d+%|tenemos descuento|te bajo el precio|igualamos precio|descuento del\s+\d+%)\b/i.test(text),
    semanticTest: (text) => /(?:\b(?:te|le)\s+(?:aplico|doy|ofrezco|hago)\b[^.!?\n]{0,30}\b(?:descuento|rebaja)\b|\b\d+\s*%\s+de\s+descuento\b)/i
      .test(normalizePrdClaimText(text)),
    fallback: 'Las condiciones comerciales especiales las revisa una ejecutiva segun el caso, volumen, producto y vigencia de la cotizacion. Te puedo derivar para evaluacion.',
  },
  {
    name: 'NO_PROMISE_DELIVERY',
    test: (text) => /\b(llega el|te llega el|despacho el|te enviamos|manana|pasado manana|en \d+ dias)\b/i.test(text)
      && !/\b(revisar|confirmar|depende|sujeto|verificar|evaluar)\b/i.test(text),
    semanticTest: (text) => {
      const normalized = normalizePrdClaimText(text);
      return /\b(llega el|te llega el|despacho el|te enviamos|manana|pasado manana|en \d+ dias|entregaremos|despacharemos|llegara|llega)\b/i.test(normalized)
        && !/\b(revisar|confirmar|depende|sujet[oa]|verificar|evaluar)\b/i.test(normalized);
    },
    fallback: 'Para revisar factibilidad de despacho necesitamos comuna, producto, cantidad y fecha tentativa. Prefiero ayudarte a confirmar un plazo realista antes de prometer algo que pueda fallar.',
  },
  {
    name: 'NO_PROMISE_INSTALLATION',
    test: (text) => /\b(instalamos|te instalamos|la instalacion es|instalacion incluida|instalacion gratis)\b/i.test(text)
      && !/\b(revisar|evaluar|depende|necesitamos|sujeto|cotizar)\b/i.test(text),
    semanticTest: (text) => {
      const normalized = normalizePrdClaimText(text);
      return /\b(instalamos|te instalamos|la instalacion es|instalacion incluida|instalacion gratis|instalaremos|iremos a instalar|quedara instalado)\b/i.test(normalized)
        && !/\b(revisar|evaluar|depende|necesitamos|sujet[oa]|cotizar)\b/i.test(normalized);
    },
    fallback: 'Para instalacion necesitamos revisar medidas, comuna, terreno, acceso y si hay retiro de escombros. Con eso se puede preparar una cotizacion mas precisa.',
  },
  {
    name: 'NO_FALSE_DERIVATION_PROMISE',
    test: (text, _catalogMatches, _priceContext, ctx) => Boolean(ctx && ctx.blockDerivationPromise)
      && /\b(voy a derivar|te voy a derivar|te derivo|derivar[ée]\b|ya derive|ya derivé|he derivado|qued[oa]s? derivad[oa]|derive tu (caso|solicitud|consulta)|derivé tu (caso|solicitud|consulta)|un[ao]? (asesor|ejecutiv[oa]|persona del equipo) (te contactar[aá]|se comunicar[aá]|te escribir[aá]))\b/i.test(text),
    fallback: 'Todavia estoy reuniendo los datos que necesito antes de derivar tu caso a un asesor. Sigamos completando la informacion para poder ayudarte.',
  },
];

const validatePrdRules = (text, catalogMatches, priceContext, ctx, enabledRuleIds = null) => {
  if (!text) return { passed: true, rule: null };
  const enabledRules = Array.isArray(enabledRuleIds) ? new Set(enabledRuleIds) : null;
  for (const validator of PRD_VALIDATORS) {
    if (enabledRules && !enabledRules.has(validator.name)) continue;
    const legacyViolation = validator.test(text, catalogMatches, priceContext, ctx);
    const semanticViolation = Boolean(ctx?.semanticPolicy && validator.semanticTest?.(text));
    if (legacyViolation || semanticViolation) {
      return { passed: false, rule: validator.name, fallback: validator.fallback };
    }
  }
  return { passed: true, rule: null };
};
// </generated:prd-validators>

const validateAiProposal = (input = {}) => {
  const row = normalizeSemanticMergeRow(input);
  const policy = asObject(row.turn_policy);
  const proposal = asObject(row.ai_proposal);
  const errors = [];
  if (policy.version !== 'ai_prd_turn_policy/v2') errors.push(error('unsupported_policy_version', 'turn_policy.version'));
  if (proposal.version !== 'ai_semantic_proposal/v2') errors.push(error('unsupported_proposal_version', 'ai_proposal.version'));
  if (proposal.contract_digest !== row.turn_policy_digest) errors.push(error('contract_digest_mismatch', 'ai_proposal.contract_digest'));
  if (typeof proposal.reply_text !== 'string') errors.push(error('reply_text_required', 'ai_proposal.reply_text'));
  if (!asArray(policy.allowed_dialogue_actions).includes(proposal.dialogue_action)) {
    errors.push(error('dialogue_action_not_allowed', 'ai_proposal.dialogue_action'));
  }
  const prdValidation = validatePrdRules(
    proposal.reply_text,
    [],
    row.price_context,
    { semanticPolicy: true },
    asArray(policy.forbidden_rule_ids)
  );
  if (!prdValidation.passed) {
    errors.push(error('forbidden_claim', 'ai_proposal.reply_text', prdValidation.rule));
  }

  const sourceMessage = asObject(policy.message);
  const activeCatalogIds = new Set(asArray(policy.catalog)
    .filter((item) => item?.is_active !== false)
    .map((item) => safe(item?.id))
    .filter(Boolean));
  const seenIds = new Set();
  const acceptedObservations = [];
  for (const [index, candidate] of asArray(proposal.observations).entries()) {
    const observation = asObject(candidate);
    const id = safe(observation.id);
    const evidence = asObject(observation.evidence);
    const path = `ai_proposal.observations[${index}]`;
    let accepted = true;
    if (!id || seenIds.has(id)) {
      errors.push(error(id ? 'duplicate_observation_id' : 'observation_id_required', `${path}.id`));
      accepted = false;
    }
    seenIds.add(id);
    if (!safe(observation.concept)) {
      errors.push(error('observation_concept_required', `${path}.concept`));
      accepted = false;
    }
    const quotedBytes = utf8Slice(sourceMessage.text, evidence.start, evidence.end);
    if (safe(evidence.message_id) !== safe(sourceMessage.id)) {
      errors.push(error('evidence_message_mismatch', `${path}.evidence.message_id`));
      accepted = false;
    }
    if (quotedBytes === null || quotedBytes !== String(evidence.quote ?? '')) {
      errors.push(error('invalid_evidence_offsets', `${path}.evidence`));
      accepted = false;
    }
    const confidence = Number(observation.confidence);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      errors.push(error('invalid_observation_confidence', `${path}.confidence`));
      accepted = false;
    }
    if (accepted) acceptedObservations.push(observation);
  }

  const observationById = new Map(acceptedObservations.map((observation) => [safe(observation.id), observation]));
  const allowedFields = new Set(asArray(policy.allowed_state_fields));
  const acceptedFields = new Set(asArray(policy.accepted_facts).map((fact) => safe(fact?.field)).filter(Boolean));
  const allowedMappings = new Set(asArray(policy.allowed_state_mappings)
    .map((mapping) => `${safe(mapping?.concept)}:${safe(mapping?.field)}`));
  const authorizedStatePatch = [];
  for (const [index, candidate] of asArray(proposal.state_patch).entries()) {
    const patch = asObject(candidate);
    const path = `ai_proposal.state_patch[${index}]`;
    let accepted = true;
    if (!allowedFields.has(patch.field)) {
      errors.push(error('state_field_not_allowed', `${path}.field`, patch.field));
      accepted = false;
    }
    const observation = observationById.get(safe(patch.observation_id));
    if (!observation) {
      errors.push(error('observation_reference_not_found', `${path}.observation_id`, patch.observation_id));
      accepted = false;
    }
    if (acceptedFields.has(patch.field)) {
      errors.push(error('accepted_fact_immutable', `${path}.field`, patch.field));
      accepted = false;
    }
    if (observation && !allowedMappings.has(`${safe(observation.concept)}:${safe(patch.field)}`)) {
      errors.push(error('state_mapping_not_allowed', path, {
        concept: safe(observation.concept),
        field: safe(patch.field),
      }));
      accepted = false;
    }
    if (patch.field === 'product' && observationById.has(safe(patch.observation_id))) {
      const grounding = asObject(observationById.get(safe(patch.observation_id)).grounding);
      if (safe(grounding.kind) !== 'catalog_item' || !activeCatalogIds.has(safe(grounding.id))) {
        errors.push(error('product_grounding_invalid', `${path}.observation_id`, grounding.id ?? null));
        accepted = false;
      }
    }
    if (accepted) authorizedStatePatch.push({ field: patch.field, observation_id: patch.observation_id });
  }

  const permissions = asObject(policy.effect_permissions);
  const authorizedEffects = [];
  const effectKeys = new Set();
  for (const [index, candidate] of asArray(proposal.requested_effects).entries()) {
    const effect = asObject(candidate);
    const type = safe(effect.type);
    const path = `ai_proposal.requested_effects[${index}]`;
    if (!['create_lead', 'handoff'].includes(type) || permissions[type] !== true) {
      errors.push(error('effect_not_allowed', `${path}.type`, type));
      continue;
    }
    const key = safe(effect.idempotency_key, `${type}:${row.turn_policy_digest}`);
    if (effectKeys.has(key)) continue;
    effectKeys.add(key);
    authorizedEffects.push({ ...effect, type, idempotency_key: key });
  }

  return {
    valid: errors.length === 0,
    rule_errors: errors,
    accepted_observations: acceptedObservations,
    authorized_state_patch: errors.length === 0 ? authorizedStatePatch : [],
    authorized_effects: errors.length === 0 ? authorizedEffects : [],
    outcome: errors.length === 0 ? 'authorized' : 'repair_required',
  };
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { validateAiProposal, normalizeSemanticMergeRow, utf8Slice, validatePrdRules, PRD_VALIDATORS };
}

if (typeof items !== 'undefined') {
  return items.map((item) => {
    const normalized = normalizeSemanticMergeRow(item?.json ?? {});
    return { json: { ...normalized, ai_validation: validateAiProposal(normalized) } };
  });
}
