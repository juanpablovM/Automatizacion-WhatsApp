const row = items[0]?.json ?? {};

const safe = (value, fallback = '') => String(value ?? fallback).trim();
const compactObject = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const clampConfidence = (value) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(1, number));
};
const extractOutputText = (response) => {
  if (!response || typeof response !== 'object') return '';
  if (typeof response.output_text === 'string') return response.output_text;
  if (typeof response.reply === 'string') return response.reply;
  if (response.reply && typeof response.reply === 'object') {
    const replyPayloads = Array.isArray(response.reply.payloads) ? response.reply.payloads : [];
    const replyPayloadText = replyPayloads.map((payload) => safe(payload?.text)).filter(Boolean).join('\n').trim();
    if (replyPayloadText) return replyPayloadText;
    if (typeof response.reply.finalAssistantVisibleText === 'string') return response.reply.finalAssistantVisibleText;
    if (typeof response.reply.finalAssistantRawText === 'string') return response.reply.finalAssistantRawText;
    return JSON.stringify(response.reply);
  }
  if (typeof response.text === 'string') return response.text;
  if (typeof response.finalAssistantVisibleText === 'string') return response.finalAssistantVisibleText;
  if (typeof response.finalAssistantRawText === 'string') return response.finalAssistantRawText;
  const choices = Array.isArray(response.choices) ? response.choices : [];
  const choiceText = choices.map((choice) => safe(choice?.message?.content, safe(choice?.text))).filter(Boolean).join('\n').trim();
  if (choiceText) return choiceText;
  const output = Array.isArray(response.output) ? response.output : [];
  const outputText = output.flatMap((entry) => Array.isArray(entry?.content) ? entry.content : [])
    .map((content) => safe(content?.text, safe(content?.output_text)))
    .filter(Boolean)
    .join('\n')
    .trim();
  if (outputText) return outputText;
  const payloads = Array.isArray(response.payloads) ? response.payloads : [];
  return payloads.map((payload) => safe(payload?.text)).filter(Boolean).join('\n').trim();
};
const parseStructuredOutput = (value) => {
  const text = safe(value).trim();
  if (!text) throw new Error('empty_output');
  try {
    return JSON.parse(text);
  } catch (_error) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('json_object_not_found');
    return JSON.parse(text.slice(start, end + 1));
  }
};
const uniqueMissing = (fields) => [...new Set(fields.filter(Boolean))];
const requiredMissingFromFields = (fields) => ['service', 'city', 'requirement'].filter((field) => !safe(fields[field]));

// Model C: PRD Validation Rules
const normalizeText = (value) =>
  String(value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9ñ\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const hasAuthorizedPriceContext = (priceContext) => {
  const context = compactObject(priceContext);
  if (!['fixed', 'reference', 'from', 'range'].includes(context.type)) return false;
  return [context.amount, context.amount_min, context.amount_max]
    .some((value) => Number.isFinite(Number(value)));
};

// PRD_VALIDATORS: SOURCE OF TRUTH is in wa-conversation-orchestrator.json
// (Apply AI Assistance node). Validation happens in the orchestrator's
// policy engine. This file must NOT define its own copy to avoid drift.
// If changing PRD rules, edit Apply AI Assistance ONLY.
const validatePrdRules = (_text, _catalogMatches, _priceContext) => {
  return { passed: true, rule: null };
};

const commercialContext = compactObject(row.commercial_context);
const commercialItems = Array.isArray(commercialContext.catalog_items) ? commercialContext.catalog_items : [];
const commercialContextCounts = compactObject(row.commercial_context_counts);
const catalogKeys = new Set(commercialItems.flatMap((item) => [item?.id, item?.sku, item?.name].map((value) => safe(value).toLowerCase()).filter(Boolean)));
const hasOfficialPriceRules = commercialItems.some((item) => Array.isArray(item?.price_rules) && item.price_rules.length > 0);
const filterCatalogMatches = (matches) => {
  if (!Array.isArray(matches)) return [];
  return matches
    .filter((match) => {
      const keys = [match?.id, match?.sku, match?.name].map((value) => safe(value).toLowerCase()).filter(Boolean);
      return keys.some((key) => catalogKeys.has(key));
    })
    .slice(0, 5)
    .map((match) => ({
      id: safe(match.id),
      sku: safe(match.sku),
      name: safe(match.name),
      reason: safe(match.reason),
    }));
};
const sanitizePriceContext = (value) => {
  const payload = compactObject(value);
  if (!hasOfficialPriceRules || Object.keys(payload).length === 0) {
    return { type: 'none', requires_validation: true, explanation: '' };
  }
  const allowedTypes = new Set(['none', 'fixed', 'reference', 'from', 'range', 'requires_human']);
  const numberOrNull = (input) => {
    const number = Number(input);
    return Number.isFinite(number) ? number : null;
  };
  return {
    type: allowedTypes.has(payload.type) ? payload.type : 'reference',
    currency: safe(payload.currency, 'CLP'),
    amount: numberOrNull(payload.amount),
    amount_min: numberOrNull(payload.amount_min),
    amount_max: numberOrNull(payload.amount_max),
    unit: safe(payload.unit),
    requires_validation: payload.requires_validation !== false,
    explanation: safe(payload.explanation),
  };
};

const existing = row.ai_context?.existing_fields || {};
const safeExisting = {
  service: safe(existing.service),
  city: safe(existing.city),
  requirement: safe(existing.requirement),
};
const fallbackMissing = requiredMissingFromFields(safeExisting);
const fallbackResult = {
  intent: 'unknown',
  service: safeExisting.service,
  city: safeExisting.city,
  requirement: safeExisting.requirement,
  missing_fields: fallbackMissing,
  confirmation_status: 'none',
  should_create_lead: false,
  needs_confirmation: true,
  confidence: 0,
  reply_text: '',
  clickup_summary: '',
  customer_type: 'unknown',
  lead_class: 'none',
  modality: 'unknown',
  diagnostic_datos: { pain: '', scope: '', timing: '', obstacle: '', next_step: '' },
  commercial_missing_fields: [],
  objection_detected: 'none',
  escalation_area: 'none',
  escalation_reason: '',
  catalog_matches: [],
  price_context: { type: 'none', requires_validation: true, explanation: '' },
  next_best_action: 'ask_data',
  handoff_reason: '',
  executive_summary: '',
  prd_validated: false,
  enhancement_type: 'none',
  explicitly_mentioned_fields: [],
  field_updates: {},
  answered_question_key: 'none',
  next_question_key: 'none',
  advisor_reasoning_summary: '',
};

let parsed = fallbackResult;
let outputText = '';
let parseError = null;
const statusCode = Number(row.ai_status_code || 0);
const responseOk = !row.ai_skipped && statusCode >= 200 && statusCode < 300;

if (responseOk) {
  outputText = extractOutputText(row.ai_response);
  try {
    parsed = parseStructuredOutput(outputText);
  } catch (error) {
    parseError = error.message;
    parsed = fallbackResult;
  }
}

const modelCEnabled = String($env.AI_MODEL_C_ENABLED || 'true').toLowerCase() === 'true';
const FIELD_ACCEPT_MIN = modelCEnabled
  ? Number($env.AI_FIELD_ACCEPT_MIN_CONFIDENCE || 0.55)
  : 0.75;
const confidence = clampConfidence(parsed.confidence);
const rawPerFieldConfidence = compactObject(parsed.per_field_confidence);
const perFieldConfidence = {
  service: clampConfidence(rawPerFieldConfidence.service ?? confidence),
  city: clampConfidence(rawPerFieldConfidence.city ?? confidence),
  requirement: clampConfidence(rawPerFieldConfidence.requirement ?? confidence),
};
const canAcceptModelFields = responseOk && !parseError && confidence >= FIELD_ACCEPT_MIN;
const modelFields = {
  service: safe(parsed.service),
  city: safe(parsed.city),
  requirement: safe(parsed.requirement),
};
const acceptedFields = canAcceptModelFields
  ? {
      service: modelFields.service || safeExisting.service,
      city: modelFields.city || safeExisting.city,
      requirement: modelFields.requirement || safeExisting.requirement,
    }
  : safeExisting;
const rejectedLowConfidenceFields = !canAcceptModelFields && Boolean(modelFields.service || modelFields.city || modelFields.requirement);

const allowedIntent = new Set(['greeting', 'quote_request', 'provide_info', 'correction', 'confirmation_yes', 'confirmation_no', 'new_request', 'continue_previous', 'irrelevant', 'unknown', 'price_inquiry', 'delivery_inquiry', 'installation_inquiry', 'stock_inquiry', 'payment_method', 'payment_proof', 'invoice_request', 'warranty_inquiry', 'complaint', 'post_sale', 'reschedule_delivery', 'reschedule_installation', 'b2b_request', 'purchase_order', 'debris_removal', 'plant_pickup', 'competitor_comparison', 'discount_request', 'returning_customer', 'review', 'talk_to_human']);
const inferIntentFromMessage = (value) => {
  const text = normalizeText(value);
  if (!text) return null;
  if (/\b(precio|valor|cuanto cuesta|cuanto sale|cotizar|cotizacion|presupuesto)\b/.test(text)) return 'price_inquiry';
  if (/\b(stock|disponibilidad|disponible)\b/.test(text)) return 'stock_inquiry';
  if (/\b(instalar|instalacion)\b/.test(text)) return 'installation_inquiry';
  if (/\b(despacho|despachar|envio|enviar)\b/.test(text)) return 'delivery_inquiry';
  if (/\b(constructora|inmobiliaria|empresa|licitacion|orden de compra|oc|factura empresa)\b/.test(text)) return 'b2b_request';
  if (/\b(reclamo|problema|falla|molesto|mala atencion)\b/.test(text)) return 'complaint';
  if (/\b(hablar con|ejecutiva|ejecutivo|asesor|humano)\b/.test(text)) return 'talk_to_human';
  return null;
};
const inferredIntent = inferIntentFromMessage(row.ai_context?.message_current);
const parsedIntent = allowedIntent.has(parsed.intent) ? parsed.intent : 'unknown';
const intentMismatch = parsedIntent === 'greeting' && Boolean(inferredIntent);
const effectiveIntent = intentMismatch ? inferredIntent : parsedIntent;
const allowedMissing = new Set(['service', 'city', 'requirement', 'confirmation']);
const allowedCommercialMissing = new Set(['name', 'product', 'commune', 'quantity', 'measurements', 'modality', 'urgency', 'photos', 'terrain', 'access', 'debris_removal', 'company', 'rut', 'contact', 'email', 'oc', 'invoice', 'payment_validation', 'human_review', 'address', 'access_restrictions', 'desired_date', 'reception_contact', 'issue_description', 'payment_amount', 'payment_method', 'sale_number', 'purchase_date', 'quote_number']);
const allowedConfirmation = new Set(['none', 'requested', 'confirmed', 'rejected', 'pending']);
const allowedCustomerType = new Set(['unknown', 'b2c', 'contractor', 'b2b', 'returning_customer', 'post_sale', 'complaint']);
const allowedLeadClass = new Set(['none', 'A', 'B', 'C', 'D', 'post_sale', 'complaint', 'general']);
const allowedModality = new Set(['unknown', 'material', 'pickup', 'delivery', 'installation', 'post_sale', 'claim']);
const allowedObjection = new Set(['none', 'price', 'competitor', 'thinking', 'urgency', 'stock', 'discount', 'payment', 'warranty', 'technical', 'other']);
const allowedEscalationArea = new Set(['none', 'sales', 'b2b', 'finance', 'post_sale', 'claims', 'scheduling', 'management']);
const allowedEnhancementType = new Set(['none', 'greeting', 'objection', 'b2b_redirect', 'price_redirect', 'data_collection', 'confirmation', 'handoff']);
const allowedQuestionKeys = new Set(['none', 'need', 'product', 'commune', 'modality', 'quantity', 'measurements', 'use_case', 'terrain', 'truck_access', 'debris_removal', 'urgency', 'photos', 'customer_type', 'company', 'company_rut', 'contact', 'email', 'purchase_order', 'invoice', 'address', 'desired_date', 'access_restrictions', 'issue_description', 'payment_details', 'final_confirmation', 'anything_else']);
const allowedUpdateKeys = new Set(['name', 'product', 'commune', 'quantity', 'measurements', 'use_case', 'modality', 'urgency', 'desired_date', 'photos', 'terrain', 'truck_access', 'debris_removal', 'customer_type', 'company', 'company_rut', 'contact_name', 'contact_role', 'email', 'purchase_order', 'invoice_required', 'address', 'access_restrictions', 'reception_contact', 'sale_number', 'purchase_date', 'issue_description', 'payment_amount', 'payment_method', 'quote_number']);
const sanitizeFieldUpdates = (value) => Object.fromEntries(
  Object.entries(compactObject(value))
    .filter(([key, fieldValue]) => allowedUpdateKeys.has(key) && (fieldValue === null || ['string', 'boolean'].includes(typeof fieldValue)))
    .map(([key, fieldValue]) => [key, typeof fieldValue === 'string' ? safe(fieldValue) : fieldValue])
);
const sanitizeDatos = (value) => {
  const payload = compactObject(value);
  return {
    pain: safe(payload.pain),
    scope: safe(payload.scope),
    timing: safe(payload.timing),
    obstacle: safe(payload.obstacle),
    next_step: safe(payload.next_step),
  };
};

const parsedMissingFields = Array.isArray(parsed.missing_fields)
  ? parsed.missing_fields.filter((field) => allowedMissing.has(field))
  : [];
const commercialMissingFields = Array.isArray(parsed.commercial_missing_fields)
  ? uniqueMissing(parsed.commercial_missing_fields.filter((field) => allowedCommercialMissing.has(field)))
  : [];
const currentStep = safe(row.ai_context?.current_step);
const pendingQuestionKey = safe(row.ai_context?.pending_question_key, 'none') === 'none'
  && currentStep.startsWith('confirm')
  ? 'final_confirmation'
  : safe(row.ai_context?.pending_question_key, 'none');
const answeredQuestionKey = allowedQuestionKeys.has(parsed.answered_question_key) ? parsed.answered_question_key : 'none';
const contextualBooleanAnswer = ['debris_removal', 'photos', 'truck_access', 'invoice', 'purchase_order', 'anything_else'].includes(pendingQuestionKey);
const rawConfirmationStatus = allowedConfirmation.has(parsed.confirmation_status)
  ? parsed.confirmation_status
  : parsedMissingFields.includes('confirmation') || parsed.needs_confirmation ? 'requested' : 'none';
const confirmationStatus = contextualBooleanAnswer ? 'none' : rawConfirmationStatus;
const contextualIntent = contextualBooleanAnswer && ['confirmation_yes', 'confirmation_no'].includes(parsed.intent)
  ? 'provide_info'
  : effectiveIntent;
const confirmationSatisfied = pendingQuestionKey === 'final_confirmation'
  && confirmationStatus === 'confirmed'
  && parsed.intent === 'confirmation_yes';
const baseMissingFields = requiredMissingFromFields(acceptedFields);
const missingFields = uniqueMissing([
  ...baseMissingFields,
  ...parsedMissingFields.filter((field) => field === 'confirmation' || baseMissingFields.includes(field)),
  ...(confirmationSatisfied ? [] : ['confirmation']),
]);
const hasRequiredLeadFields = Boolean(acceptedFields.service && acceptedFields.city && acceptedFields.requirement);
const modelShouldCreateLead = Boolean(parsed.should_create_lead);
const guardedShouldCreateLead = modelShouldCreateLead && hasRequiredLeadFields && confirmationSatisfied && confidence >= 0.75 && !parseError;

const HEALTHY_MIN = modelCEnabled
  ? Number($env.AI_HEALTHY_MIN_CONFIDENCE || 0.45)
  : 0.75;
const explicitlyMentionedFields = Array.isArray(parsed.explicitly_mentioned_fields)
  ? parsed.explicitly_mentioned_fields.filter((field) => ['service', 'city', 'requirement'].includes(field))
  : [];
const fallbackReason = row.ai_request_error
  ? row.ai_request_error
  : row.ai_skipped
    ? row.ai_skip_reason || 'skipped'
    : !responseOk
      ? statusCode === 429 ? 'rate_limited' : 'provider_error'
      : parseError
        ? 'invalid_json'
        : intentMismatch
          ? 'intent_mismatch'
          : confidence < HEALTHY_MIN
            ? 'low_confidence'
            : null;

const provider = safe(row.ai_provider, 'google');
const apiMode = safe(row.ai_api_mode, 'openai_responses');
const catalogMatches = canAcceptModelFields ? filterCatalogMatches(parsed.catalog_matches) : [];
const priceContext = canAcceptModelFields ? sanitizePriceContext(parsed.price_context) : { type: 'none', requires_validation: true, explanation: '' };

const prdValidationEnabled = String($env.AI_PRD_VALIDATION_ENABLED || 'false').toLowerCase() === 'true';
const replyText = intentMismatch ? '' : safe(parsed.reply_text);
const prdValidation = prdValidationEnabled
  ? validatePrdRules(replyText, catalogMatches, priceContext)
  : { passed: true, rule: null };
const prdValidated = prdValidation.passed;
const enhancementType = allowedEnhancementType.has(parsed.enhancement_type) ? parsed.enhancement_type : 'none';

const allowedSalesStage = new Set(['greeting', 'exploration', 'qualification', 'recommendation', 'objection', 'quote', 'agenda', 'confirmation', 'ready_for_sales', 'not_qualified']);
const allowedBuyingIntent = new Set(['low', 'medium', 'high']);
const allowedUrgency = new Set(['low', 'medium', 'high']);
const allowedNextAction = new Set(['ask_data', 'recommend_product', 'answer_question', 'handle_objection', 'quote_reference', 'offer_agenda', 'confirm', 'handoff_sales', 'handoff_b2b', 'handoff_finance', 'handoff_post_sale', 'handoff_claims', 'close_not_qualified']);
const customerType = allowedCustomerType.has(parsed.customer_type) ? parsed.customer_type : 'unknown';
const leadClass = allowedLeadClass.has(parsed.lead_class) ? parsed.lead_class : 'none';
const modality = allowedModality.has(parsed.modality) ? parsed.modality : 'unknown';
const objectionDetected = allowedObjection.has(parsed.objection_detected) ? parsed.objection_detected : 'none';
const escalationArea = allowedEscalationArea.has(parsed.escalation_area) ? parsed.escalation_area : 'none';
const diagnosticDatos = sanitizeDatos(parsed.diagnostic_datos);

return [
  {
    json: {
      ai_skipped: Boolean(row.ai_skipped),
      ai_skip_reason: row.ai_skip_reason || null,
      ai_provider: provider,
      ai_model: row.ai_model || null,
      ai_api_mode: apiMode,
      ai_status_code: row.ai_status_code || null,
      ai_retry_attempts: row.ai_retry_attempts || 0,
      ai_retry_exhausted: Boolean(row.ai_retry_exhausted),
      ai_retry_after_ms: row.ai_retry_after_ms || null,
      ai_circuit_open: Boolean(row.ai_circuit_open),
      ai_response_headers: compactObject(row.ai_response_headers),
      ai_parse_error: parseError,
      ai_request_error: row.ai_request_error || null,
      ai_fallback_reason: fallbackReason,
      intent: contextualIntent,
      lead_quality: ['none', 'low', 'medium', 'high'].includes(parsed.lead_quality) ? parsed.lead_quality : 'none',
      customer_type: customerType,
      lead_class: leadClass,
      modality,
      sales_stage: allowedSalesStage.has(parsed.sales_stage) ? parsed.sales_stage : null,
      buying_intent: allowedBuyingIntent.has(parsed.buying_intent) ? parsed.buying_intent : null,
      urgency: allowedUrgency.has(parsed.urgency) ? parsed.urgency : null,
      service: acceptedFields.service,
      city: acceptedFields.city,
      requirement: acceptedFields.requirement,
      missing_fields: missingFields,
      commercial_missing_fields: commercialMissingFields,
      diagnostic_datos: diagnosticDatos,
      confirmation_status: confirmationStatus,
      should_create_lead: guardedShouldCreateLead,
      model_should_create_lead_raw: modelShouldCreateLead,
      needs_confirmation: Boolean(parsed.needs_confirmation || !guardedShouldCreateLead),
      confidence,
      reply_text: canAcceptModelFields ? replyText : '',
      clickup_summary: guardedShouldCreateLead ? safe(parsed.clickup_summary) : '',
      catalog_matches: catalogMatches,
      price_context: priceContext,
      objection_detected: objectionDetected,
      escalation_area: escalationArea,
      escalation_reason: safe(parsed.escalation_reason),
      next_best_action: allowedNextAction.has(parsed.next_best_action) ? parsed.next_best_action : null,
      per_field_confidence: perFieldConfidence,
      handoff_reason: safe(parsed.handoff_reason),
      executive_summary: safe(parsed.executive_summary),
      prd_validated: prdValidated,
      prd_rule_violated: prdValidation.rule || null,
      enhancement_type: enhancementType,
      explicitly_mentioned_fields: explicitlyMentionedFields,
      field_updates: canAcceptModelFields ? sanitizeFieldUpdates(parsed.field_updates) : {},
      answered_question_key: answeredQuestionKey,
      next_question_key: allowedQuestionKeys.has(parsed.next_question_key) ? parsed.next_question_key : 'none',
      advisor_reasoning_summary: safe(parsed.advisor_reasoning_summary),
      metadata_json: JSON.stringify({
        provider,
        model: row.ai_model || null,
        api_mode: apiMode,
        status_code: row.ai_status_code || null,
        retry_attempts: row.ai_retry_attempts || 0,
        retry_exhausted: Boolean(row.ai_retry_exhausted),
        retry_after_ms: row.ai_retry_after_ms || null,
        circuit_open: Boolean(row.ai_circuit_open),
        response_headers: compactObject(row.ai_response_headers),
        request_chars: row.ai_request_chars || null,
        parse_error: parseError,
        request_error: row.ai_request_error || null,
        fallback_reason: fallbackReason,
        model_intent: parsedIntent,
        inferred_intent: inferredIntent,
        intent_mismatch: intentMismatch,
        model_should_create_lead_raw: modelShouldCreateLead,
        model_fields_rejected_low_confidence: rejectedLowConfidenceFields,
        guardrail_has_required_lead_fields: hasRequiredLeadFields,
        guardrail_confirmation_satisfied: confirmationSatisfied,
        raw_output_length: outputText.length,
        commercial_context_counts: commercialContextCounts,
        customer_type: customerType,
        lead_class: leadClass,
        modality,
        objection_detected: objectionDetected,
        escalation_area: escalationArea,
        escalation_reason: safe(parsed.escalation_reason),
        commercial_missing_fields: commercialMissingFields,
        diagnostic_datos: diagnosticDatos,
        catalog_matches_count: catalogMatches.length,
        price_context_type: priceContext.type,
        price_context_requires_validation: priceContext.requires_validation,
        prd_validated: prdValidated,
        prd_rule_violated: prdValidation.rule || null,
        per_field_confidence: perFieldConfidence,
        enhancement_type: enhancementType,
        explicitly_mentioned_fields: explicitlyMentionedFields,
        pending_question_key: pendingQuestionKey,
        answered_question_key: answeredQuestionKey,
        next_question_key: allowedQuestionKeys.has(parsed.next_question_key) ? parsed.next_question_key : 'none',
        field_accept_min: FIELD_ACCEPT_MIN,
        healthy_min: HEALTHY_MIN,
      }),
    },
  },
];

