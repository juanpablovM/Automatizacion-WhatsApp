// =============================================================================
// conversation-flow-v2: New Turn Contract (Phase 1 — Schema Reference)
// =============================================================================
// This change moves to Gemini as the sole conversational voice. The
// deterministic layer becomes a policy/escalation engine. Below are the
// new/extended fields in the turn contract.
//
// PER-FIELD CONFIDENCE (instead of global score):
//   confidence field-level: number 0-1 per extracted field
//   Threshold: >0.8 auto-advance, <0.8 ask confirmation for that field only
//
// ESCALATION FIELDS:
//   escalation_area: 'none' | 'sales' | 'b2b' | 'finance' | 'post_sale'
//                   | 'claims' | 'scheduling' | 'management'
//   escalation_reason: string — why the escalation was triggered
//   escalation_threshold_met: 'loop' | 'frustration' | 'b2b' | 'complex'
//   consecutive_failures: number — turns without progress in same field
//
// FIELD_UPDATES (extended — qualification context):
//   { name, product, commune, quantity, measurements, use_case,
//     modality, urgency, desired_date, photos, terrain, truck_access,
//     debris_removal, customer_type, company, company_rut, ... }
//
// LAST 3-4 MESSAGES CONTEXT:
//   recent_messages: [{ role: 'user'|'assistant', content: string }]
//   — Already loaded by Load Conversation State query
//
// NEXT_ACTION ENUM (new values):
//   'ask_data' | 'confirm_field' | 'auto_advance' | 'escalate' |
//   'generate_quote' | 'send_quote' | 'handoff_lead' | 'end'
//
// QUOTATION FIELDS (Phase 4 — TBD format):
//   quote_ready: boolean
//   quote_summary: string
//   quote_sent: boolean
//
// See proposal: sdd/conversation-flow-v2/proposal
// See design:   sdd/conversation-flow-v2/design
// See spec:     sdd/conversation-flow-v2/spec
// =============================================================================

const row = items[0]?.json ?? {};

const pick = (...values) => {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' && value.trim() === '') continue;
    return value;
  }
  return null;
};
const asArray = (value) => Array.isArray(value) ? value : [];
const asObject = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const jsonString = (value, fallback) => {
  try {
    return JSON.stringify(value ?? fallback);
  } catch (_error) {
    return JSON.stringify(fallback);
  }
};
const parseJsonObject = (value) => {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value || '{}'));
    return asObject(parsed);
  } catch (_error) {
    return {};
  }
};
const safe = (value, fallback = '') => String(value ?? fallback).trim();
const hasValue = (value) => safe(value).length > 0;
const normalizeText = (value) =>
  String(value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9ñ\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

// Model C: PRD Validation Rules
const hasAuthorizedPriceContext = (priceContext) => {
  const context = asObject(priceContext);
  if (!['fixed', 'reference', 'from', 'range'].includes(context.type)) return false;
  return [context.amount, context.amount_min, context.amount_max]
    .some((value) => Number.isFinite(Number(value)));
};

// PRD_VALIDATORS: SOURCE OF TRUTH.
// This is the ONLY place where PRD rules are defined.
// The ai-lead-qualification-assistant workflow MUST NOT define its own copy.
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
    fallback: 'Puedo levantar tu solicitud, pero la disponibilidad debe confirmarla el equipo antes de cerrar la venta.',
  },
  {
    name: 'NO_CONFIRM_PAYMENT',
    test: (text) => /\b(pago confirmado|transferencia recibida|ya puedes retirar|ya esta validado|pago acreditado)\b/i.test(text),
    fallback: 'Recibimos el comprobante. La validacion final del pago la realiza Finanzas una vez que el monto este acreditado. Te avisaremos cuando quede confirmado.',
  },
  {
    name: 'NO_DISCOUNT',
    test: (text) => /\b(te puedo hacer\s+\d+%|tenemos descuento|te bajo el precio|igualamos precio|descuento del\s+\d+%)\b/i.test(text),
    fallback: 'Las condiciones comerciales especiales las revisa una ejecutiva segun el caso, volumen, producto y vigencia de la cotizacion. Te puedo derivar para evaluacion.',
  },
  {
    name: 'NO_PROMISE_DELIVERY',
    test: (text) => /\b(llega el|te llega el|despacho el|te enviamos|manana|pasado manana|en \d+ dias)\b/i.test(text)
      && !/\b(revisar|confirmar|depende|sujeto|verificar|evaluar)\b/i.test(text),
    fallback: 'Para revisar factibilidad de despacho necesitamos comuna, producto, cantidad y fecha tentativa. Prefiero ayudarte a confirmar un plazo realista antes de prometer algo que pueda fallar.',
  },
  {
    name: 'NO_PROMISE_INSTALLATION',
    test: (text) => /\b(instalamos|te instalamos|la instalacion es|instalacion incluida|instalacion gratis)\b/i.test(text)
      && !/\b(revisar|evaluar|depende|necesitamos|sujeto|cotizar)\b/i.test(text),
    fallback: 'Para instalacion necesitamos revisar medidas, comuna, terreno, acceso y si hay retiro de escombros. Con eso se puede preparar una cotizacion mas precisa.',
  },
];

const validatePrdRules = (text, catalogMatches, priceContext) => {
  if (!text) return { passed: true, rule: null };
  for (const validator of PRD_VALIDATORS) {
    if (validator.test(text, catalogMatches, priceContext)) {
      return { passed: false, rule: validator.name, fallback: validator.fallback };
    }
  }
  return { passed: true, rule: null };
};

// AG5: Heuristica para detectar si el usuario menciono un campo explicitamente
const userMentionedField = (field, userText) => {
  const norm = (v) => String(v ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9ñ\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const text = norm(userText);
  
  if (field === 'city') {
    const cities = ['santiago', 'valparaiso', 'viña', 'vina', 'concon', 'quilpue', 'villa alemana', 'limache', 'olmue', 'casablanca', 'curacavi', 'puente alto', 'la florida', 'las condes', 'providencia', 'ñuñoa', 'maipu', 'san bernardo', 'melipilla', 'talagante', 'buin', 'padre hurtado', 'la granja', 'san ramon', 'pedro aguirre cerda', 'lo espejo', 'cerrillos', 'quilicura', 'huechuraba', 'renca', 'independencia', 'recoleta', 'conchali', 'colina', 'lantana', 'til til', 'linares', 'rancagua', 'san antonio'];
    return cities.some(c => text.includes(c)) || /\b(en|desde|hacia|para)\s+[a-zñ]+\b/.test(text);
  }
  
  if (field === 'service') {
    const products = ['adocesped', 'adocreto', 'adoquin', 'baldosa', 'pastelon', 'duriente', 'bloque', 'placa', 'poste', 'solera', 'solerilla', 'tapa', 'camara', 'basas', 'pilar', 'borde', 'piscina', 'macetero', 'cilindro', 'cemento', 'pigmento', 'piedra', 'serena', 'cuarzo', 'fuget', 'alambre', 'puas', 'concertina', 'vidrio', 'templado', 'espejo', 'incer', 'ceramico', 'porcelanato', 'instalacion', 'venta', 'mantenimiento', 'reparacion', 'movimiento', 'tierra', 'replanteo', 'excavacion', 'vaciado', 'transporte'];
    return products.some(p => text.includes(p)) || /\b(servicio|instalacion|venta|mantenimiento|reparacion)\b/.test(text);
  }
  
  if (field === 'requirement') {
    return /\b(necesito|quiero|requiero|ocupo|necesitaria|quisiera)\b/.test(text)
      || /\b(instalar|reparar|comprar|cambiar|renovar|reemplazar|poner|colocar|hacer)\b/.test(text)
      || /\b(metro|m2|m\d*|cantidad|unidad|pieza)\b/.test(text)
      || /\b(urgencia|urgente|para|hasta|plazo|fecha|cuando|antes|despues)\b/.test(text)
      || /\b(color|gris|blanco|negro|rojo|cafe|beige|arena|natural)\b/.test(text);
  }
  
  return false;
};

const decodeStepState = (encoded) => {
  if (!encoded) return {};
  try {
    const parsed = JSON.parse(decodeURIComponent(encoded));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_error) {
    return {};
  }
};
const parseStep = (value) => {
  const raw = safe(value, 'city');
  const [stepValue, encodedState] = raw.split('|');
  const match = stepValue.match(/^(.+?)(?:_retry_(\d+))?$/);
  return {
    field: match ? match[1] : stepValue,
    retry: Number(match?.[2] || 0),
    state: decodeStepState(encodedState),
  };
};
const encodeStep = (field, state) => {
  const payload = {
    service: state.service || null,
    city: state.city || null,
    requirement: state.requirement || null,
  };
  const hasPayload = Object.values(payload).some((value) => safe(value));
  return hasPayload ? field + '|' + encodeURIComponent(JSON.stringify(payload)) : field;
};
const confirmationText = (state) => [
  'Tengo esto:',
  'Servicio: ' + state.service,
  'Ciudad: ' + state.city,
  'Requerimiento: ' + state.requirement,
  '',
  '¿Está correcto?',
].join('\n');
const nextQuestion = (missing) => {
  if (missing === 'city') return '¿Desde qué ciudad nos escribes?';
  if (missing === 'service') return '¿Qué servicio estás buscando?';
  if (missing === 'requirement') return 'Cuéntame brevemente qué necesitas resolver, instalar, reparar o comprar.';
  return '¿Está correcto?';
};
const missingFieldsFor = (state) => {
  if (!hasValue(state.city)) return 'city';
  if (!hasValue(state.service)) return 'service';
  if (!hasValue(state.requirement)) return 'requirement';
  return 'confirm';
};

const aiEnabled = String($env.AI_LEAD_ASSISTANT_ENABLED || 'true').toLowerCase() === 'true';
const deterministicFields = [
  'phone_number',
  'source_number_id',
  'instance_name',
  'inbound_event_id',
  'processing_token',
  'whatsapp_name',
  'external_contact_id',
  'external_message_id',
  'external_timestamp',
  'message_type',
  'text_body',
  'raw_payload_json',
  'attachment_type',
  'mime_type',
  'filename',
  'external_media_id',
  'external_url',
  'sha256',
  'file_size',
  'conversation_id',
  'lead_id',
  'reset_conversation_lead',
  'previous_lead_id',
  'service',
  'city',
  'requirement',
  'current_step',
  'conversation_status_code',
  'should_create_lead',
  'should_escalate',
  'escalation_reason',
  'is_partial',
  'response_text',
  'deterministic_reply',
  'response_kind',
  'normalized_text',
  'completed_fields_count',
  'has_intent',
  'audit_event_name',
  'audit_result',
  'before_payload_json',
  'after_payload_json',
  'metadata_json',
  'qualification_context',
  'pending_question_key',
];
const deterministicValue = (field) => (Object.prototype.hasOwnProperty.call(row, field + '_1') ? row[field + '_1'] : row[field]);
const deterministic = {};
for (const field of deterministicFields) {
  deterministic[field] = deterministicValue(field);
}
deterministic.should_create_lead = Boolean(deterministic.should_create_lead);
deterministic.completed_fields_count = Number(deterministic.completed_fields_count || 0);
deterministic.has_intent = Boolean(deterministic.has_intent);
// conversation-flow-v2: Escalation fields
deterministic.should_escalate = Boolean(deterministic.should_escalate);
deterministic.escalation_reason = safe(deterministic.escalation_reason);
deterministic.is_partial = Boolean(deterministic.is_partial);
deterministic.reset_conversation_lead = Boolean(deterministic.reset_conversation_lead);

const aiMetadataFromAssistant = parseJsonObject(pick(row.metadata_json, row.metadata_json_1, '{}'));
const ai = {
  skipped: Boolean(pick(row.ai_skipped, row.ai_skipped_1, false)),
  skip_reason: pick(row.ai_skip_reason, row.ai_skip_reason_1),
  fallback_reason: pick(row.ai_fallback_reason, row.ai_fallback_reason_1),
  parse_error: pick(row.ai_parse_error, row.ai_parse_error_1),
  request_error: pick(row.ai_request_error, row.ai_request_error_1),
  status_code: pick(row.ai_status_code, row.ai_status_code_1),
  retry_exhausted: Boolean(pick(row.ai_retry_exhausted, row.ai_retry_exhausted_1, false)),
  provider: safe(pick(row.ai_provider, row.ai_provider_1, 'google')),
  model: pick(row.ai_model, row.ai_model_1),
  intent: safe(pick(row.intent, row.intent_1)),
  lead_quality: safe(pick(row.lead_quality, row.lead_quality_1)),
  customer_type: safe(pick(row.customer_type, row.customer_type_1)),
  lead_class: safe(pick(row.lead_class, row.lead_class_1)),
  modality: safe(pick(row.modality, row.modality_1)),
  sales_stage: safe(pick(row.sales_stage, row.sales_stage_1)),
  buying_intent: safe(pick(row.buying_intent, row.buying_intent_1)),
  urgency: safe(pick(row.urgency, row.urgency_1)),
  service: safe(row.service),
  city: safe(row.city),
  requirement: safe(row.requirement),
  confirmation_status: safe(pick(row.confirmation_status, row.confirmation_status_1)),
  confidence: Number(pick(row.confidence, row.confidence_1, 0)),
  reply_text: safe(pick(row.reply_text, row.reply_text_1)),
  should_create_lead: Boolean(pick(row.should_create_lead, false)),
  diagnostic_datos: asObject(pick(row.diagnostic_datos, row.diagnostic_datos_1, {})),
  commercial_missing_fields: asArray(pick(row.commercial_missing_fields, row.commercial_missing_fields_1, [])),
  catalog_matches: asArray(pick(row.catalog_matches, row.catalog_matches_1, [])),
  price_context: asObject(pick(row.price_context, row.price_context_1, {})),
  objection_detected: safe(pick(row.objection_detected, row.objection_detected_1)),
  escalation_area: safe(pick(row.escalation_area, row.escalation_area_1)),
  next_best_action: safe(pick(row.next_best_action, row.next_best_action_1)),
  handoff_reason: safe(pick(row.handoff_reason, row.handoff_reason_1)),
  executive_summary: safe(pick(row.executive_summary, row.executive_summary_1)),
  prd_validated: Boolean(pick(row.prd_validated, row.prd_validated_1, false)),
  prd_rule_violated: safe(pick(row.prd_rule_violated, row.prd_rule_violated_1)),
  enhancement_type: safe(pick(row.enhancement_type, row.enhancement_type_1)),
  explicitly_mentioned_fields: asArray(pick(row.explicitly_mentioned_fields, row.explicitly_mentioned_fields_1, [])),
  field_updates: asObject(pick(row.field_updates, row.field_updates_1, {})),
  answered_question_key: safe(pick(row.answered_question_key, row.answered_question_key_1, 'none')),
  next_question_key: safe(pick(row.next_question_key, row.next_question_key_1, 'none')),
  advisor_reasoning_summary: safe(pick(row.advisor_reasoning_summary, row.advisor_reasoning_summary_1)),
  commercial_context_counts: asObject(aiMetadataFromAssistant.commercial_context_counts),
  per_field_confidence: asObject(pick(row.per_field_confidence, row.per_field_confidence_1, {})),
};

const currentStepInfo = parseStep(deterministic.current_step);
const normalizedText = normalizeText(deterministic.normalized_text || deterministic.text_body);
const explicitCorrection = ai.intent === 'correction'
  || ai.intent === 'new_request'
  || /\b(no es|no una|no un|sino|corregir|corrijo|correccion|corrección|cambiar|cambio|modificar|modifico|quise decir|me equivoque|me equivoqué)\b/.test(normalizedText);
const deterministicResolvedClearly = deterministic.should_create_lead || ['handoff_ready', 'confirmation_question', 'previous_context_choice', 'confirmation_rejected'].includes(safe(deterministic.response_kind));

const modelCEnabled = String($env.AI_MODEL_C_ENABLED || 'true').toLowerCase() === 'true';
const AI_HEALTHY_MIN = modelCEnabled
  ? Number($env.AI_HEALTHY_MIN_CONFIDENCE || 0.45)
  : 0.75;
const FIELD_ACCEPT_MIN = modelCEnabled
  ? Number($env.AI_FIELD_ACCEPT_MIN_CONFIDENCE || 0.55)
  : 0.75;
const REPLY_TEXT_MIN = modelCEnabled
  ? Number($env.AI_REPLY_TEXT_MIN_CONFIDENCE || 0.50)
  : 0.75;
const OBJECTION_MIN = modelCEnabled
  ? Number($env.AI_OBJECTION_MIN_CONFIDENCE || 0.50)
  : 0.75;
const B2B_MIN = modelCEnabled
  ? Number($env.AI_B2B_MIN_CONFIDENCE || 0.55)
  : 0.75;
const prdValidationEnabled = String($env.AI_PRD_VALIDATION_ENABLED || 'true').toLowerCase() === 'true';

// Model C: AI Health Assessment
const aiHealthy = aiEnabled && !ai.skipped && !ai.parse_error && !ai.request_error && !ai.fallback_reason && !ai.retry_exhausted && ai.confidence >= AI_HEALTHY_MIN;
const aiFieldsAcceptable = aiHealthy && ai.confidence >= FIELD_ACCEPT_MIN;
const aiReplyAcceptable = aiHealthy && ai.confidence >= REPLY_TEXT_MIN;
const aiObjectionAcceptable = aiHealthy && ai.confidence >= OBJECTION_MIN
  && ai.objection_detected && ai.objection_detected !== 'none';
const aiB2bAcceptable = aiHealthy && ai.confidence >= B2B_MIN
  && (ai.customer_type === 'b2b' || ai.lead_class === 'D');

// conversation-flow-v2: Per-field confidence (>0.8 auto-advance, <0.8 needs confirmation)
const perFieldConfidence = ai.per_field_confidence || {};
const autoAdvanceThreshold = 0.8;
const fieldNeedsConfirm = (field) => {
  const pfc = perFieldConfidence[field];
  if (pfc === undefined || pfc === null) return false; // no per-field signal → use default flow
  return pfc < autoAdvanceThreshold;
};

const state = {
  service: safe(deterministic.service),
  city: safe(deterministic.city),
  requirement: safe(deterministic.requirement),
};
const qualificationContext = {
  ...asObject(deterministic.qualification_context),
};
const resetQualificationContext = deterministic.reset_conversation_lead;
if (resetQualificationContext) {
  for (const key of Object.keys(qualificationContext)) delete qualificationContext[key];
}
const allowedQualificationKeys = new Set(['name', 'product', 'commune', 'quantity', 'measurements', 'use_case', 'modality', 'urgency', 'desired_date', 'photos', 'terrain', 'truck_access', 'debris_removal', 'customer_type', 'company', 'company_rut', 'contact_name', 'contact_role', 'email', 'purchase_order', 'invoice_required', 'address', 'access_restrictions', 'reception_contact', 'sale_number', 'purchase_date', 'issue_description', 'payment_amount', 'payment_method', 'quote_number']);
const normalizedCurrentText = normalizeText(deterministic.text_body);
const pendingQuestionToField = {
  product: 'product', commune: 'commune', quantity: 'quantity', measurements: 'measurements',
  use_case: 'use_case', modality: 'modality', urgency: 'urgency', desired_date: 'desired_date',
  photos: 'photos', terrain: 'terrain', truck_access: 'truck_access', debris_removal: 'debris_removal',
  customer_type: 'customer_type', company: 'company', company_rut: 'company_rut', contact: 'contact_name',
  email: 'email', purchase_order: 'purchase_order', invoice: 'invoice_required', address: 'address',
  access_restrictions: 'access_restrictions', issue_description: 'issue_description', payment_details: 'payment_amount',
};
const secondaryFieldHasDirectEvidence = (key, text) => {
  const patterns = {
    product: /\b(adocret|adoquin|baldos|pastelon|solerill|bloque|placa|poste|maceter|cemento|cuarzo)\w*\b/,
    commune: /\b(comuna|ciudad|en|desde)\s+[a-zñ]+/,
    quantity: /\b\d+(?:[.,]\d+)?\s*(?:unidades?|piezas?|sacos?|palets?)\b/,
    measurements: /\b\d+(?:[.,]\d+)?\s*(?:m2|m²|metros?|cm|mm)\b/,
    modality: /\b(solo material|retiro|despacho|delivery|instalacion|instalar)\b/,
    urgency: /\b(urgente|urgencia|esta semana|este mes|cuanto antes)\b/,
    desired_date: /\b(?:lunes|martes|miercoles|jueves|viernes|sabado|domingo|enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre|\d{1,2}[/-]\d{1,2})\b/,
    photos: /\b(foto|imagen)\w*\b/,
    terrain: /\b(terreno|plano|pendiente|nivelado)\b/,
    truck_access: /\b(camion|acceso vehicular)\b/,
    debris_removal: /\b(escombro|retiro de material)\w*\b/,
    customer_type: /\b(empresa|constructora|particular|contratista)\b/,
    company: /\b(empresa|constructora|sociedad)\b/,
    company_rut: /\b\d{1,2}\.?\d{3}\.?\d{3}-[0-9k]\b/,
    contact_name: /\b(mi nombre es|soy|contacto)\b/,
    email: /\b[^\s@]+@[^\s@]+\.[^\s@]+\b/,
    purchase_order: /\b(orden de compra|oc)\b/,
    invoice_required: /\b(factura)\b/,
    address: /\b(calle|avenida|av |pasaje|direccion)\b/,
    access_restrictions: /\b(restriccion|acceso estrecho|sin acceso)\b/,
    issue_description: /\b(falla|problema|roto|quebrado|reclamo)\b/,
    payment_amount: /\$\s*\d|\b\d+[.,]?\d*\s*(?:pesos|clp)\b/,
    payment_method: /\b(transferencia|tarjeta|efectivo)\b/,
    quote_number: /\b(cotizacion|presupuesto)\s*(?:n|numero|#)?\s*\d+\b/,
    sale_number: /\b(venta|pedido)\s*(?:n|numero|#)?\s*\d+\b/,
    purchase_date: /\b(compra|compre)\b.*\b(?:ayer|hoy|\d{1,2}[/-]\d{1,2})\b/,
    reception_contact: /\b(recibe|recepcion|contacto en obra)\b/,
    contact_role: /\b(jefe de obra|compras|supervisor|administrador)\b/,
    use_case: /\b(patio|entrada|obra|jardin|cierre|terreno)\b/,
  };
  return Boolean(patterns[key]?.test(text));
};
if (aiFieldsAcceptable && !resetQualificationContext) {
  const pendingField = pendingQuestionToField[deterministic.pending_question_key] || null;
  for (const [key, value] of Object.entries(ai.field_updates)) {
    if (!allowedQualificationKeys.has(key) || value === null || value === '') continue;
    const evidenced = key === pendingField || secondaryFieldHasDirectEvidence(key, normalizedCurrentText);
    if (evidenced && (typeof value === 'string' || typeof value === 'boolean')) {
      qualificationContext[key] = value;
    }
  }
}
const booleanByQuestion = {
  debris_removal: 'debris_removal',
  photos: 'photos',
  truck_access: 'truck_access',
  invoice: 'invoice_required',
  purchase_order: 'purchase_order',
};
const pendingBooleanField = booleanByQuestion[deterministic.pending_question_key];
if (pendingBooleanField && /^(si|sí|s|no|nop)$/.test(normalizedCurrentText)) {
  qualificationContext[pendingBooleanField] = /^(si|sí|s)$/.test(normalizedCurrentText);
}
const measurementMatch = String(deterministic.text_body || '').match(/\b\d+(?:[.,]\d+)?\s*(?:m2|m²|metros?\s+cuadrados?|metros?\s+lineales?|metros?)\b/i);
if (measurementMatch && !qualificationContext.measurements) {
  qualificationContext.measurements = measurementMatch[0];
}
if (deterministic.pending_question_key === 'terrain' && normalizedCurrentText && normalizedCurrentText.length <= 80) {
  qualificationContext.terrain = safe(deterministic.text_body);
}
if (!resetQualificationContext) {
  qualificationContext.diagnostic_datos = ai.diagnostic_datos;
  qualificationContext.customer_type = ai.customer_type || qualificationContext.customer_type || null;
  qualificationContext.lead_class = ai.lead_class || qualificationContext.lead_class || null;
  qualificationContext.modality = ai.modality || qualificationContext.modality || null;
  qualificationContext.objection_detected = ai.objection_detected || qualificationContext.objection_detected || 'none';
  qualificationContext.executive_summary = ai.executive_summary || qualificationContext.executive_summary || null;
}
const beforeState = { ...state };
const acceptedAiFields = [];

// Model C: maybeApply uses aiFieldsAcceptable
// conversation-flow-v2: Per-field confidence
const maybeApply = (field) => {
  const value = safe(ai[field]);
  if (!value || deterministic.response_kind === 'escalation_already_required') return;
  const directUserEvidence = userMentionedField(field, deterministic.text_body);
  const explicitlyMentioned = directUserEvidence
    && (ai.explicitly_mentioned_fields.includes(field) || explicitCorrection);
  if (deterministic.reset_conversation_lead && !hasValue(state[field])) return;
  const fieldConfidence = Number(perFieldConfidence[field] ?? ai.confidence ?? 0);
  const fieldOk = (aiFieldsAcceptable && fieldConfidence >= 0.75) || explicitlyMentioned;
  if (fieldOk && (!hasValue(state[field]) || explicitlyMentioned)) {
    state[field] = value;
    acceptedAiFields.push(field);
    // Track per-field confidence for confirmation decisions
    if (!confidenceAlreadyHigh && fieldNeedsConfirm(field)) {
      fieldsNeedingFieldConfirm.push(field);
    }
  }
};
const fieldsNeedingFieldConfirm = [];
let confidenceAlreadyHigh = false;

if (aiHealthy) {
  maybeApply('city');
  maybeApply('service');
  maybeApply('requirement');
}
const displayValue = (value) => typeof value === 'boolean' ? (value ? 'Si' : 'No') : (safe(value) || 'No informado');
const executiveSummary = [
  `Cliente: ${qualificationContext.name || deterministic.whatsapp_name || 'No informado'}`,
  `Tipo de cliente: ${qualificationContext.customer_type || ai.customer_type || 'No informado'}`,
  `Clasificacion: ${qualificationContext.lead_class || ai.lead_class || 'No informada'}`,
  `Producto: ${state.service || qualificationContext.product || 'No informado'}`,
  `Modalidad: ${qualificationContext.modality || ai.modality || 'No informada'}`,
  `Comuna: ${state.city || qualificationContext.commune || 'No informada'}`,
  `Cantidad/medidas: ${displayValue(qualificationContext.measurements || qualificationContext.quantity)}`,
  `Urgencia: ${displayValue(qualificationContext.urgency || qualificationContext.desired_date)}`,
  `Terreno: ${displayValue(qualificationContext.terrain)}`,
  `Acceso camion: ${displayValue(qualificationContext.truck_access)}`,
  `Retiro escombros: ${displayValue(qualificationContext.debris_removal)}`,
  `Fotos: ${displayValue(qualificationContext.photos)}`,
  `Necesidad: ${state.requirement || 'No informada'}`,
  `Objecion: ${qualificationContext.objection_detected || ai.objection_detected || 'Ninguna'}`,
].join('\n');
if (!resetQualificationContext) qualificationContext.executive_summary = executiveSummary;

const hasRequiredLeadFields = hasValue(state.service) && hasValue(state.city) && hasValue(state.requirement);

// =============================================================================
// PRD Unit 1: Gate determinista de campos obligatorios por intencion.
// Fuente normativa: PRD Hormiglass secciones 13.1..13.8 y reglas 16/17/18/19.
// SOURCE OF TRUTH: este nodo (Apply AI Assistance). El workflow AI NUNCA define
// su propia copia de esta politica para evitar deriva; solo la implementa.
// -----------------------------------------------------------------------------
// Cada perfil declara:
//   - compulsory:  campos que BLOQUEAN la creacion de lead cuando faltan
//     (la confirmacion del turno se cancela y se pregunta el primer faltante).
//   - conditional: campos que se recogen de forma oportunista; NO bloquean.
//   - satisfiedByWhatsApp: provistos desde el remitente (nombre, telefono).
//   - payment:     campos de pago/factura/OC (comprobante, factura, OC).
// Regla final (PRD): nunca confirmar ni crear lead con datos obligatorios
// pendientes. "No confirmar lo que no esta garantizado."
// =============================================================================
const COMMERCIAL_FIELD_POLICY = {
  material: {
    profile: 'Cotizacion de material (PRD 13.1)',
    compulsory: ['product', 'quantity', 'commune', 'modality'],
    conditional: ['desired_date', 'urgency', 'invoice'],
    satisfiedByWhatsApp: ['name', 'phone'],
    payment: ['invoice'],
  },
  instalacion: {
    profile: 'Cotizacion con instalacion (PRD 13.2)',
    compulsory: ['product', 'quantity', 'commune', 'terrain', 'access', 'debris_removal'],
    conditional: ['measurements', 'photos', 'desired_date', 'urgency', 'invoice'],
    satisfiedByWhatsApp: ['name', 'phone'],
    payment: ['invoice'],
  },
  despacho: {
    profile: 'Cotizacion con despacho (PRD 13.4)',
    compulsory: ['product', 'quantity', 'commune', 'address', 'access_restrictions'],
    conditional: ['reception_contact', 'desired_date', 'urgency', 'invoice'],
    satisfiedByWhatsApp: ['name', 'phone'],
    payment: ['invoice'],
  },
  retiro: {
    profile: 'Retiro en planta (PRD 13.5)',
    compulsory: ['product'],
    conditional: ['quantity', 'desired_date', 'reception_contact', 'payment_validation'],
    satisfiedByWhatsApp: ['name', 'phone'],
    payment: ['payment_validation'],
  },
  b2b: {
    profile: 'Cotizacion B2B (PRD 13.3)',
    compulsory: ['company', 'contact', 'product', 'quantity', 'commune', 'oc'],
    conditional: ['rut', 'email', 'desired_date', 'invoice', 'human_review'],
    satisfiedByWhatsApp: ['name', 'phone'],
    payment: ['invoice', 'oc'],
  },
  reclamo: {
    profile: 'Reclamo (PRD 13.6) ',
    compulsory: ['issue_description'],
    conditional: ['sale_number', 'purchase_date', 'photos', 'urgency', 'commune', 'product'],
    satisfiedByWhatsApp: ['name', 'phone'],
    payment: [],
  },
  garantia: {
    profile: 'Garantia (PRD 13.7)',
    compulsory: ['issue_description'],
    conditional: ['product', 'sale_number', 'purchase_date', 'photos'],
    satisfiedByWhatsApp: ['name', 'phone'],
    payment: [],
  },
  comprobante: {
    profile: 'Comprobante de pago (PRD 13.8)',
    compulsory: ['payment_amount', 'payment_method'],
    conditional: ['photos', 'sale_number', 'quote_number', 'payment_validation'],
    satisfiedByWhatsApp: ['name', 'phone'],
    payment: ['payment_validation'],
  },
  factura: {
    profile: 'Solicitud de factura (PRD 31.6)',
    compulsory: ['invoice'],
    conditional: ['email', 'company', 'rut', 'quote_number'],
    satisfiedByWhatsApp: ['name', 'phone'],
    payment: ['invoice'],
  },
};

const COMMERCIAL_FIELD_SOURCES = {
  product: (ctx, s) => ctx.product || s.service,
  quantity: (ctx) => ctx.quantity || ctx.measurements,
  measurements: (ctx) => ctx.measurements,
  commune: (ctx, s) => s.city || ctx.commune,
  modality: (ctx) => ctx.modality,
  terrain: (ctx) => ctx.terrain,
  access: (ctx) => ctx.truck_access,
  debris_removal: (ctx) => ctx.debris_removal,
  photos: (ctx) => ctx.photos,
  desired_date: (ctx) => ctx.desired_date,
  urgency: (ctx) => ctx.urgency,
  address: (ctx) => ctx.address,
  access_restrictions: (ctx) => ctx.access_restrictions,
  reception_contact: (ctx) => ctx.reception_contact,
  company: (ctx) => ctx.company,
  rut: (ctx) => ctx.company_rut,
  contact: (ctx) => ctx.contact_name,
  email: (ctx) => ctx.email,
  oc: (ctx) => ctx.purchase_order,
  invoice: (ctx) => ctx.invoice_required,
  issue_description: (ctx) => ctx.issue_description,
  sale_number: (ctx) => ctx.sale_number,
  purchase_date: (ctx) => ctx.purchase_date,
  payment_amount: (ctx) => ctx.payment_amount,
  payment_method: (ctx) => ctx.payment_method,
  quote_number: (ctx) => ctx.quote_number,
  payment_validation: () => false,
  human_review: () => false,
};
const commercialFieldSatisfied = (key, ctx, s) => {
  const source = COMMERCIAL_FIELD_SOURCES[key];
  if (!source) return true;
  const value = source(ctx, s);
  if (typeof value === 'boolean') return true;
  return hasValue(value);
};

const COMMERCIAL_QUESTION_KEYS = {
  product: 'product', commune: 'commune', quantity: 'quantity', measurements: 'measurements',
  modality: 'modality', terrain: 'terrain', access: 'truck_access', debris_removal: 'debris_removal',
  photos: 'photos', desired_date: 'desired_date', urgency: 'urgency', address: 'address',
  access_restrictions: 'access_restrictions', reception_contact: 'contact', company: 'company',
  contact: 'contact', email: 'email', rut: 'company_rut', oc: 'purchase_order', invoice: 'invoice',
  issue_description: 'issue_description', sale_number: 'issue_description', purchase_date: 'issue_description',
  payment_amount: 'payment_details', payment_method: 'payment_details', quote_number: 'payment_details',
  payment_validation: 'payment_details', human_review: 'contact',
};

const resolveCommercialProfile = (qctx) => {
  const intent = safe(ai.intent);
  const modality = safe(qctx.modality || ai.modality);
  const isB2b = !resetQualificationContext && Boolean(
    ai.customer_type === 'b2b'
    || ai.lead_class === 'D'
    || qctx.customer_type === 'b2b'
    || qctx.lead_class === 'D'
  );
  if (isB2b || intent === 'b2b_request' || intent === 'purchase_order') return 'b2b';
  if (intent === 'installation_inquiry' || intent === 'debris_removal' || modality === 'installation') return 'instalacion';
  if (intent === 'delivery_inquiry' || modality === 'delivery') return 'despacho';
  if (intent === 'plant_pickup' || modality === 'pickup') return 'retiro';
  if (intent === 'complaint' || qctx.customer_type === 'complaint' || (ai.customer_type === 'complaint')) return 'reclamo';
  if (intent === 'warranty_inquiry') return 'garantia';
  if (intent === 'payment_proof') return 'comprobante';
  if (intent === 'invoice_request' || Boolean(qctx.invoice_required)) return 'factura';
  return 'material';
};
const firstMissedCommercialField = (assessment) => {
  const questionLabels = {
    product: 'producto', commune: 'comuna', quantity: 'cantidad', measurements: 'medidas',
    modality: 'modalidad', terrain: 'terreno', access: 'acceso camion', debris_removal: 'debris removal',
    address: 'direccion', access_restrictions: 'restricciones de acceso', desired_date: 'fecha deseada',
    photos: 'fotos', urgency: 'urgencia', company: 'empresa', contact: 'contacto', email: 'correo',
    oc: 'orden de compra', invoice: 'factura', issue_description: 'descripcion del problema',
    sale_number: 'numero de venta', purchase_date: 'fecha de compra', payment_amount: 'monto',
    payment_method: 'medio de pago', quote_number: 'numero de cotizacion', rut: 'RUT empresa',
    payment_validation: 'validacion Finanzas', human_review: 'revision humana',
  };
  const profile = COMMERCIAL_FIELD_POLICY[assessment.profile];
  if (!profile || !Array.isArray(assessment.missing) || assessment.missing.length === 0) return null;
  const field = assessment.missing[0];
  return { field, label: questionLabels[field] || field };
};
const computeCommercialMissingFields = (qctx, s) => {
  const profileKey = resolveCommercialProfile(qctx);
  const profile = COMMERCIAL_FIELD_POLICY[profileKey];
  if (!profile) return { profile: profileKey, missing: [] };
  const missing = profile.compulsory.filter((field) => !commercialFieldSatisfied(field, qctx, s));
  return { profile: profileKey, missing };
};
const commercialAssessment = computeCommercialMissingFields(qualificationContext, state);
const commercialMissingProfile = commercialAssessment.profile;
const commercialMissingFields = commercialAssessment.missing;
const firstCommercialMissingField = firstMissedCommercialField(commercialAssessment);
const activeCommercialProfile = COMMERCIAL_FIELD_POLICY[commercialMissingProfile] || null;

const explicitRejectionText = /^(no|nop|incorrecto|incorrecta|no encontrada|incorrecto|no es correcto|quiero cambiar|cambiar|modificar|corregir)$/.test(normalizedCurrentText);
const explicitConfirmationText = /^(si|s|ok|okay|dale|correcto|correcta|confirmo|esta correcto|asi es|si esta correcto|si por favor|si correcto|si correcta|de acuerdo)$/.test(normalizedCurrentText);
const awaitingFinalConfirmation = currentStepInfo.field === 'confirm'
  && (!deterministic.pending_question_key || deterministic.pending_question_key === 'final_confirmation');
const aiConfirmed = ai.confirmation_status === 'confirmed'
  && ai.intent === 'confirmation_yes'
  && explicitConfirmationText
  && awaitingFinalConfirmation;
// PRD-1 Unit 1: la confirmacion comercial queda bloqueada mientras existan
// campos comerciales obligatorios pendientes. El LLM puede querer confirmar,
// pero el orquestador es la capa determinista que decide.
const commercialGateBlocked = commercialMissingFields.length > 0;
const aiCanCreateLead = aiHealthy && ai.should_create_lead && hasRequiredLeadFields && aiConfirmed && ai.confidence >= 0.75 && !commercialGateBlocked;
const aiRequestsOperationalEscalation = Boolean(
  ai.escalation_area
  && ai.escalation_area !== 'none'
  && ai.escalation_area !== 'sales'
);
const isEscalation = deterministic.should_escalate || aiRequestsOperationalEscalation;
const deterministicCreatesLead = Boolean(deterministic.should_create_lead);
const shouldCreateLead = !isEscalation && !commercialGateBlocked && (deterministicCreatesLead || aiCanCreateLead);
// Estados de confirmacion del turno (PRD-1): pending mientras el gate pida datos.
const missingBaseConfirmation = hasRequiredLeadFields && awaitingFinalConfirmation && !commercialGateBlocked;
const aiWantsToConfirm = ai.intent === 'confirmation_yes'
  || (missingBaseConfirmation && !commercialGateBlocked)
  || awaitingFinalConfirmation;
const effectiveConfirmationStatus = shouldCreateLead
  ? 'confirmed'
  : commercialGateBlocked && (ai.intent === 'confirmation_yes' || awaitingFinalConfirmation)
    ? 'pending'
    : missingBaseConfirmation
      ? 'requested'
      : ai.intent === 'confirmation_no'
        ? 'rejected'
        : 'none';
const needsConfirmationFlag = !shouldCreateLead
  && !isEscalation
  && (commercialGateBlocked || missingBaseConfirmation || ai.intent === 'confirmation_yes');
const isConfirmationCorrectionTurn = !shouldCreateLead
  && currentStepInfo.field === 'confirm'
  && (
    deterministic.response_kind === 'confirmation_correction_requested'
    || (
      explicitRejectionText
      && (
        deterministic.pending_question_key === 'final_confirmation'
        || deterministic.pending_question_key === 'confirmation_correction'
        || !deterministic.pending_question_key
      )
    )
  );
const requiredQuestionKey = (() => {
  if (shouldCreateLead || isConfirmationCorrectionTurn || isEscalation) return null;
  // PRD-1 Unit 1: si aun faltan campos comerciales obligatorios, se pregunta el
  // primero faltante en lugar de pedir la confirmacion final o crear el lead.
  if (hasRequiredLeadFields && firstCommercialMissingField) {
    return COMMERCIAL_QUESTION_KEYS[firstCommercialMissingField.field] || 'final_confirmation';
  }
  const modality = qualificationContext.modality;
  if (modality === 'installation') {
    if (!qualificationContext.measurements) return 'measurements';
    if (!qualificationContext.terrain) return 'terrain';
    if (qualificationContext.truck_access === undefined || qualificationContext.truck_access === null) return 'truck_access';
    if (qualificationContext.debris_removal === undefined || qualificationContext.debris_removal === null) return 'debris_removal';
  }
  if (modality === 'delivery') {
    if (!qualificationContext.quantity && !qualificationContext.measurements) return 'quantity';
    if (!qualificationContext.address) return 'address';
    if (!qualificationContext.access_restrictions) return 'access_restrictions';
  }
  if (!resetQualificationContext && (ai.customer_type === 'b2b' || ai.lead_class === 'D')) {
    if (!qualificationContext.company) return 'company';
    if (!qualificationContext.contact_name) return 'contact';
    if (!qualificationContext.quantity && !qualificationContext.measurements) return 'quantity';
    if (qualificationContext.purchase_order === undefined || qualificationContext.purchase_order === null) return 'purchase_order';
  }
  return hasRequiredLeadFields ? 'final_confirmation' : null;
})();
const pendingQuestionKey = shouldCreateLead || isEscalation
  ? null
  : isConfirmationCorrectionTurn
    ? 'confirmation_correction'
    : requiredQuestionKey
      || (ai.next_question_key && ai.next_question_key !== 'none' ? ai.next_question_key : deterministic.pending_question_key || null);
const missing = missingFieldsFor(state);
// conversation-flow-v2: If fields were accepted but with low per-field confidence, ask field-level confirmation
const nextStepField = shouldCreateLead ? 'complete'
  : missing === 'confirm' ? 'confirm'
  : missing;

// Model C: Response Selection Logic
const selectResponseText = () => {
  // PRIORITY 1: Lead creation
  if (shouldCreateLead) {
    if (aiReplyAcceptable && ai.reply_text) {
      const validation = prdValidationEnabled
      ? validatePrdRules(ai.reply_text, ai.catalog_matches, ai.price_context)
      : { passed: true, rule: null };
      if (!validation.passed) {
        return {
          text: validation.fallback,
          kind: 'prd_validated_fallback',
          metadata: { prd_rule_violated: validation.rule },
        };
      }
      return { text: '', kind: 'handoff_pending' };
    }
    return {
      text: '',
      kind: 'handoff_pending',
    };
  }

  // PRIORITY 2: Escalation and rejected final confirmation are terminal policies
  // for this turn; advisor guardrails must not overwrite their visible question.
  if (isEscalation) {
    if (deterministic.response_kind === 'escalation_already_required') {
      return { text: deterministic.deterministic_reply || 'Tu solicitud ya está derivada a una persona del equipo.', kind: 'escalation_already_required' };
    }
    return {
      text: 'No quiero hacerte repetir lo mismo. Te derivaré con una persona del equipo para continuar.',
      kind: 'escalation_routing',
    };
  }
  if (isConfirmationCorrectionTurn) {
    return {
      text: 'Entiendo. ¿Qué dato de la solicitud quieres corregir?',
      kind: 'confirmation_correction_requested',
    };
  }

  // PRIORITY 3: AI response available - validate and select
  if (aiReplyAcceptable && ai.reply_text) {
    const validation = prdValidationEnabled
      ? validatePrdRules(ai.reply_text, ai.catalog_matches, ai.price_context)
      : { passed: true, rule: null };
    
    // PRD violation - use fallback
    if (!validation.passed) {
      return {
        text: validation.fallback,
        kind: 'prd_validated_fallback',
        metadata: { prd_rule_violated: validation.rule },
      };
    }

    // Objection handling - NEW
    if (aiObjectionAcceptable) {
      return {
        text: ai.reply_text,
        kind: 'objection_response',
        metadata: { objection_type: ai.objection_detected },
      };
    }

    // B2B detection - NEW
    if (aiB2bAcceptable && missing !== 'confirm') {
      return {
        text: ai.reply_text,
        kind: 'b2b_response',
        metadata: { customer_type: ai.customer_type, lead_class: ai.lead_class },
      };
    }

    // Confirmation step
    if (missing === 'confirm') {
      return {
        text: ai.reply_text,
        kind: 'confirmation_question',
      };
    }

    // Price/stock/install redirect - NEW
    const redirectIntents = ['price_inquiry', 'stock_inquiry', 'installation_inquiry',
      'delivery_inquiry', 'payment_method', 'warranty_inquiry', 'competitor_comparison',
      'discount_request'];
    if (redirectIntents.includes(ai.intent) && missing !== 'confirm') {
      return {
        text: ai.reply_text,
        kind: 'ai_redirect',
        metadata: { redirect_intent: ai.intent },
      };
    }

    // La IA es la voz principal. Si supero guardrails, su respuesta se envia
    // incluso cuando no agrego campos estructurados nuevos.
    return {
      text: ai.reply_text,
      kind: ai.enhancement_type && ai.enhancement_type !== 'none'
        ? 'ai_' + ai.enhancement_type
        : 'ai_conversation',
    };
  }

  // PRIORITY 3: AI fields were accepted - use deterministic next question
  if (acceptedAiFields.length) {
    if (missing === 'confirm') {
      return { text: confirmationText(state), kind: 'confirmation_question' };
    }
    return { text: nextQuestion(missing), kind: 'ai_assisted_question' };
  }

  // PRIORITY 4: Fallback to deterministic
  return {
    text: deterministic.response_text || deterministic.deterministic_reply || 'No pude procesar tu respuesta. ¿Podrías intentarlo nuevamente?',
    kind: deterministic.response_kind || 'deterministic_fallback',
  };
};

const selectedResponse = selectResponseText();
let responseText = selectedResponse.text;
let responseKind = selectedResponse.kind;
const responseMetadata = selectedResponse.metadata || {};
const advisorQuestion = (key) => {
  const project = state.service || 'tu proyecto';
  const city = state.city ? ' en ' + state.city : '';
  if (key === 'measurements') return `Para orientar bien ${project}${city}, ¿qué medidas aproximadas necesitas cubrir?`;
  if (key === 'terrain') return `Perfecto, ya tengo las medidas. Para evaluar correctamente la instalación, ¿el terreno está plano o tiene pendiente?`;
  if (key === 'truck_access') return 'Gracias, eso ayuda a evaluar la instalación. ¿Hay acceso para que ingrese un camión al lugar?';
  if (key === 'debris_removal') return 'Con eso ya tenemos una buena base técnica. ¿La instalación requiere retirar escombros o material antiguo?';
  if (key === 'quantity') return `Para dimensionar correctamente la cotización de ${project}, ¿qué cantidad aproximada necesitas?`;
  if (key === 'address') return 'Para revisar la factibilidad del despacho, ¿cuál es la dirección aproximada de entrega?';
  if (key === 'access_restrictions') return '¿Hay alguna restricción de acceso para el camión en el lugar de entrega?';
  if (key === 'company') return 'Para preparar correctamente la solicitud B2B, ¿cuál es el nombre de la empresa?';
  if (key === 'contact') return '¿Cuál es el nombre y cargo de la persona de contacto para esta cotización?';
  if (key === 'purchase_order') return '¿La compra se gestionará con Orden de Compra?';
  if (key === 'product') return `¿Qué producto de hormigón necesitas para ${project}?`;
  if (key === 'commune') return '¿En qué comuna o ciudad se realizará el proyecto?';
  if (key === 'modality') return '¿La necesitas como solo material, con despacho, retiro en planta o instalación?';
  if (key === 'photos') return '¿Puedes enviarnos fotos del lugar o del material para evaluarlo mejor?';
  if (key === 'desired_date') return '¿Para cuándo necesitarías esta fecha estimada?';
  if (key === 'urgency') return '¿Hay alguna urgencia o fecha límite para este requerimiento?';
  if (key === 'email') return '¿Cuál es el correo de contacto para enviar la cotización o documentación?';
  if (key === 'company_rut') return '¿Cuál es el RUT de la empresa para la facturación B2B?';
  if (key === 'invoice') return '¿Necesitas factura por esta compra?';
  if (key === 'issue_description') return 'Cuéntame brevemente qué problema necesitas resolver para poder ayudarte y derivarte correctamente.';
  if (key === 'payment_details') return 'Para registrar el comprobante necesito el monto y el medio de pago utilizado. ¿Me los confirmas?';
  if (key === 'final_confirmation') {
    return `Tengo registrado ${project}${city} para ${state.requirement}. ¿Confirmas que estos datos están correctos para derivar la cotización?`;
  }
  return responseText;
};
if (!shouldCreateLead && !isConfirmationCorrectionTurn && !isEscalation && requiredQuestionKey) {
  responseText = advisorQuestion(requiredQuestionKey);
  responseKind = 'advisor_guardrail_question';
}

// Model C: Step management
const currentStep = shouldCreateLead ? encodeStep('complete', state)
  : isEscalation ? encodeStep('escalation', state)
  : isConfirmationCorrectionTurn
    ? encodeStep('confirm_retry_' + Math.max(1, currentStepInfo.retry), state)
    : acceptedAiFields.length ? encodeStep(nextStepField, state)
    : deterministic.current_step;
const effectiveCurrentStepField = parseStep(currentStep).field;
// A confirmed lead handoff is a sales outcome, while operational escalations
// are mutually exclusive with lead creation.
const escalationReason = isEscalation
  ? (deterministic.escalation_reason || ai.escalation_area || null)
  : null;
const conversationStatusCode = shouldCreateLead
  ? 'handed_to_sales'
  : isEscalation
    ? 'escalation_required'
    : deterministic.conversation_status_code;
const completedFieldsCount = ['service', 'city', 'requirement'].filter((field) => hasValue(state[field])).length;

const originalMetadata = (() => {
  try {
    return JSON.parse(deterministic.metadata_json || '{}');
  } catch (_error) {
    return {};
  }
})();
const originalAfter = (() => {
  try {
    return JSON.parse(deterministic.after_payload_json || '{}');
  } catch (_error) {
    return {};
  }
})();
const afterPayload = {
  ...originalAfter,
  service: state.service || null,
  city: state.city || null,
  requirement: state.requirement || null,
  current_step: currentStep,
  current_step_field: effectiveCurrentStepField,
  conversation_status_code: conversationStatusCode,
  should_create_lead: shouldCreateLead,
  should_escalate: isEscalation,
  escalation_reason: escalationReason,
  qualification_context: qualificationContext,
  pending_question_key: pendingQuestionKey,
  commercial_missing_fields: commercialMissingFields,
  confirmation_status: effectiveConfirmationStatus,
  needs_confirmation: needsConfirmationFlag,
};

// Model C: Enhanced metadata
const aiMetadata = {
  ...originalMetadata,
  ai_enabled: aiEnabled,
  ai_invoked: aiEnabled,
  ai_applied: acceptedAiFields.length > 0 || (aiReplyAcceptable && Boolean(ai.reply_text)) || aiCanCreateLead,
  ai_eligible: aiHealthy,
  ai_autonomous_create_lead: aiCanCreateLead,
  ai_intent: ai.intent || null,
  ai_confidence: Number.isFinite(ai.confidence) ? ai.confidence : 0,
  ai_confirmation_status: ai.confirmation_status || null,
  ai_fallback_reason: ai.fallback_reason || ai.request_error || ai.skip_reason || ai.parse_error || null,
  ai_accepted_fields: acceptedAiFields,
  ai_before_fields: beforeState,
  ai_model_requested_create_lead: ai.should_create_lead,
  ai_creation_blocked_by_orchestrator: ai.should_create_lead && !aiCanCreateLead && !deterministicCreatesLead,
  // PRD-1 Unit 1: diagnostico del gate comercial determinista.
  commercial_policy_profile: commercialMissingProfile,
  commercial_policy_blocked: commercialGateBlocked,
  commercial_first_missing_field: commercialGateBlocked
    ? (firstCommercialMissingField ? firstCommercialMissingField.field : null)
    : null,
  commercial_confirmation_cancelled: commercialGateBlocked && ai.intent === 'confirmation_yes',
  ai_escalation_requested: isEscalation,
  ai_provider: ai.provider || null,
  ai_model: ai.model || null,
  ai_status_code: ai.status_code || null,
  ai_parse_error: ai.parse_error || null,
  ai_request_error: ai.request_error || null,
  ai_lead_quality: ai.lead_quality || null,
  ai_customer_type: ai.customer_type || null,
  ai_lead_class: ai.lead_class || null,
  ai_modality: ai.modality || null,
  ai_sales_stage: ai.sales_stage || null,
  ai_buying_intent: ai.buying_intent || null,
  ai_urgency: ai.urgency || null,
  ai_objection_detected: ai.objection_detected || null,
  ai_escalation_area: ai.escalation_area || null,
  ai_next_best_action: ai.next_best_action || null,
  ai_handoff_reason: ai.handoff_reason || null,
  ai_executive_summary: executiveSummary,
  ai_commercial_missing_fields: ai.commercial_missing_fields,
  ai_diagnostic_datos: ai.diagnostic_datos,
  ai_catalog_matches_count: ai.catalog_matches.length,
  ai_price_context_type: ai.price_context.type || null,
  ai_explicitly_mentioned_fields: ai.explicitly_mentioned_fields,
  ai_answered_question_key: ai.answered_question_key,
  ai_next_question_key: ai.next_question_key,
  ai_advisor_reasoning_summary: ai.advisor_reasoning_summary || null,
  per_field_confidence: perFieldConfidence,
  commercial_context_counts: ai.commercial_context_counts,
  // Model C specific
  model_c_enabled: modelCEnabled,
  ai_healthy_min: AI_HEALTHY_MIN,
  ai_field_accept_min: FIELD_ACCEPT_MIN,
  ai_reply_text_min: REPLY_TEXT_MIN,
  ai_objection_min: OBJECTION_MIN,
  ai_b2b_min: B2B_MIN,
  ai_fields_acceptable: aiFieldsAcceptable,
  ai_reply_acceptable: aiReplyAcceptable,
  ai_objection_acceptable: aiObjectionAcceptable,
  ai_b2b_acceptable: aiB2bAcceptable,
  response_kind_model_c: responseKind,
  prd_rule_violated: responseMetadata.prd_rule_violated || ai.prd_rule_violated || null,
  objection_type: responseMetadata.objection_type || null,
  redirect_intent: responseMetadata.redirect_intent || null,
};

return [
  {
    json: {
      ...deterministic,
      service: state.service || null,
      city: state.city || null,
      requirement: state.requirement || null,
      current_step: currentStep,
      conversation_status_code: conversationStatusCode,
      should_create_lead: shouldCreateLead,
      qualification_context: qualificationContext,
      qualification_context_json: jsonString(qualificationContext, {}),
      pending_question_key: pendingQuestionKey,
      response_text: responseText,
      response_kind: responseKind,
      completed_fields_count: completedFieldsCount,
      audit_result: shouldCreateLead ? 'handed_to_sales' : isEscalation ? 'escalation_required' : 'waiting_user',
      after_payload_json: JSON.stringify(afterPayload),
      metadata_json: JSON.stringify(aiMetadata),
      ai_invoked: aiEnabled,
      ai_skipped: ai.skipped,
      ai_provider: ai.provider || null,
      ai_model: ai.model || null,
      ai_status_code: ai.status_code || null,
      ai_parse_error: ai.parse_error || null,
      ai_request_error: ai.request_error || null,
      ai_applied: acceptedAiFields.length > 0 || (aiReplyAcceptable && Boolean(ai.reply_text)) || aiCanCreateLead,
      ai_accepted_fields: acceptedAiFields,
      ai_accepted_fields_json: jsonString(acceptedAiFields, []),
      ai_fallback_reason: ai.fallback_reason || ai.request_error || ai.skip_reason || ai.parse_error || null,
      intent: ai.intent || null,
      lead_quality: ai.lead_quality || null,
      customer_type: ai.customer_type || null,
      lead_class: ai.lead_class || null,
      modality: ai.modality || null,
      sales_stage: ai.sales_stage || null,
      buying_intent: ai.buying_intent || null,
      urgency: ai.urgency || null,
      confidence: Number.isFinite(ai.confidence) ? ai.confidence : 0,
      per_field_confidence: perFieldConfidence,
      deterministic_reply: deterministic.deterministic_reply || null,
      diagnostic_datos: ai.diagnostic_datos,
      diagnostic_datos_json: jsonString(ai.diagnostic_datos, {}),
      // PRD-1 Unit 1: commercial_missing_fields es determinista (derivado de la
      // politica PRD por intencion, no del LLM). Confirma la realidad del estado
      // y la usa el dispatcher y la capa de persistencia para bloquear la creacion.
      commercial_missing_fields: commercialMissingFields,
      commercial_missing_fields_json: jsonString(commercialMissingFields, []),
      commercial_policy_profile: commercialMissingProfile,
      confirmation_status: effectiveConfirmationStatus,
      needs_confirmation: needsConfirmationFlag,
      catalog_matches: ai.catalog_matches,
      catalog_matches_json: jsonString(ai.catalog_matches, []),
      price_context: ai.price_context,
      price_context_json: jsonString(ai.price_context, {}),
      commercial_context_counts_json: jsonString(ai.commercial_context_counts, {}),
      objection_detected: ai.objection_detected || null,
      escalation_area: ai.escalation_area || null,
      should_escalate: isEscalation,
      escalation_reason: escalationReason,
      next_best_action: ai.next_best_action || null,
      handoff_reason: ai.handoff_reason || null,
      executive_summary: executiveSummary,
      prd_validated: ai.prd_validated,
      prd_rule_violated: ai.prd_rule_violated || null,
      enhancement_type: ai.enhancement_type || null,
      field_updates: ai.field_updates,
      field_updates_json: jsonString(ai.field_updates, {}),
      answered_question_key: ai.answered_question_key,
      next_question_key: ai.next_question_key,
      advisor_reasoning_summary: ai.advisor_reasoning_summary || null,
    },
  },
];

