const row = items[0]?.json ?? {};

const safe = (value, fallback = '') => String(value ?? fallback).trim();
const compactObject = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const pickMerged = (...values) => {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' && value.trim() === '') continue;
    return value;
  }
  return null;
};
const parseJsonObject = (value) => {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return compactObject(parsed);
  } catch (_error) {
    return {};
  }
};
const arrayCount = (value) => Array.isArray(value) ? value.length : 0;
const parseRecentMessages = (value) => {
  let messages = value;
  if (typeof messages === 'string') {
    try {
      messages = JSON.parse(messages);
    } catch (_error) {
      return [];
    }
  }
  if (!Array.isArray(messages)) return [];
  return messages
    .filter((message) => message && typeof message === 'object')
    .map((message) => ({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content: safe(message.content),
    }))
    .filter((message) => message.content)
    .slice(-8);
};
const compactCommercialContext = (context) => ({
  catalog_items: (Array.isArray(context.catalog_items) ? context.catalog_items : []).slice(0, 5).map((item) => ({
    id: item.id,
    sku: item.sku,
    name: item.name,
    item_type: item.item_type,
    short_description: item.short_description,
    applicable_cities: item.applicable_cities,
    restrictions: item.restrictions,
    price_rules: (Array.isArray(item.price_rules) ? item.price_rules : []).slice(0, 3).map((rule) => ({
      code: rule.code,
      price_type: rule.price_type,
      currency: rule.currency,
      amount: rule.amount,
      amount_min: rule.amount_min,
      amount_max: rule.amount_max,
      unit: rule.unit,
      conditions: rule.conditions,
      is_reference: rule.is_reference,
    })),
  })),
  conditions: (Array.isArray(context.conditions) ? context.conditions : []).slice(0, 5).map((condition) => ({
    code: condition.code,
    title: condition.title,
    condition_type: condition.condition_type,
    body: condition.body,
  })),
  faqs: (Array.isArray(context.faqs) ? context.faqs : []).slice(0, 4).map((faq) => ({
    question: faq.question,
    answer: faq.answer,
    tags: faq.tags,
  })),
  objections: (Array.isArray(context.objections) ? context.objections : []).slice(0, 4).map((objection) => ({
    objection_type: objection.objection_type,
    customer_signal: objection.customer_signal,
    recommended_response: objection.recommended_response,
    escalation_rule: objection.escalation_rule,
  })),
  available_slots: (Array.isArray(context.available_slots) ? context.available_slots : []).slice(0, 3),
});
const isPlaceholder = (value) => {
  const text = safe(value);
  return !text || /^__.*__$/.test(text) || text === '__PENDIENTE__';
};
const aiEnabled = String($env.AI_LEAD_ASSISTANT_ENABLED || 'true').toLowerCase() === 'true';
const provider = safe($env.AI_PROVIDER, 'google').toLowerCase();
const model = safe($env.AI_DIRECT_API_MODEL);
const requestPath = safe($env.AI_DIRECT_API_PATH, '/chat/completions');
const usesChatCompletions = requestPath.includes('/chat/completions');
const apiMode = usesChatCompletions ? 'chat_completions' : 'responses';
const baseUrl = safe($env.AI_DIRECT_API_BASE_URL, 'https://generativelanguage.googleapis.com/v1beta/openai').replace(/\/+$/, '');
const directApiKey = safe($env.AI_DIRECT_API_KEY);
const timeoutMs = Number($env.AI_DIRECT_API_TIMEOUT_MS || 120000);
const turnPolicy = parseJsonObject(pickMerged(row.turn_policy, row.turn_policy_1));
const requestedContractVersion = safe(pickMerged(row.contract_version, row.contract_version_1)).toLowerCase();
const usesV3Contract = requestedContractVersion === 'v3' || turnPolicy.version === 'ai_prd_turn_policy/v3';

if (usesV3Contract) {
  const observationSchema = {
    type: 'object',
    additionalProperties: false,
    required: [
      'id', 'concept', 'raw_value', 'normalized_value', 'evidence_quote',
      'evidence_occurrence', 'grounding_ref', 'resolves_goal_ids',
    ],
    properties: {
      id: { type: 'string' },
      concept: { type: 'string' },
      raw_value: { type: 'string' },
      normalized_value: {
        anyOf: [
          { type: 'string' },
          { type: 'number' },
          { type: 'boolean' },
          { type: 'null' },
          {
            type: 'object',
            additionalProperties: false,
            required: ['kind', 'value', 'unit', 'name'],
            properties: {
              kind: { type: ['string', 'null'] },
              value: { type: ['string', 'number', 'boolean', 'null'] },
              unit: { type: ['string', 'null'] },
              name: { type: ['string', 'null'] },
            },
          },
        ],
      },
      evidence_quote: { type: 'string' },
      evidence_occurrence: { type: 'integer', minimum: 1 },
      grounding_ref: { type: ['string', 'null'] },
      resolves_goal_ids: { type: 'array', items: { type: 'string' } },
    },
  };
  const v3ResponseSchema = {
    type: 'object',
    additionalProperties: false,
    required: [
      'version', 'policy_digest', 'reply_text', 'primary_request',
      'observations', 'state_mutations', 'effect_requests',
    ],
    properties: {
      version: { type: 'string', enum: ['ai_conversation_proposal/v3'] },
      policy_digest: { type: 'string' },
      reply_text: { type: 'string' },
      primary_request: {
        type: ['object', 'null'],
        additionalProperties: false,
        required: ['text', 'goal_id'],
        properties: {
          text: { type: 'string' },
          goal_id: { type: 'string' },
        },
      },
      observations: { type: 'array', items: observationSchema },
      state_mutations: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['operation', 'field', 'observation_id', 'replaces_fact_id'],
          properties: {
            operation: { type: 'string', enum: ['set', 'replace'] },
            field: { type: 'string' },
            observation_id: { type: 'string' },
            replaces_fact_id: { type: ['string', 'null'] },
          },
        },
      },
      effect_requests: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['type', 'reason_observation_ids'],
          properties: {
            type: { type: 'string' },
            reason_observation_ids: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
  };
  const v3BasePayload = {
    ...row,
    ai_contract_version: 'v3',
    ai_provider: provider,
    ai_model: model,
    ai_base_url: baseUrl,
    ai_api_mode: apiMode,
    turn_policy: turnPolicy,
    response_schema: v3ResponseSchema,
  };
  const v3PolicyValid = turnPolicy.version === 'ai_prd_turn_policy/v3'
    && /^[a-f0-9]{64}$/.test(safe(turnPolicy.policy_digest));
  if (!v3PolicyValid) {
    return [{ json: { ...v3BasePayload, ai_skipped: false, ai_request: null, ai_request_error: 'invalid_turn_policy', ai_request_path: requestPath, ai_timeout_ms: timeoutMs } }];
  }
  const shadowPolicyValid = row.shadow_mode !== true || (
    Array.isArray(turnPolicy.state_authority?.allowed_mutations)
      && turnPolicy.state_authority.allowed_mutations.length === 0
      && Array.isArray(turnPolicy.effect_authority?.permissions)
      && turnPolicy.effect_authority.permissions.length === 0
  );
  if (!shadowPolicyValid) {
    return [{ json: { ...v3BasePayload, ai_skipped: false, ai_request: null, ai_request_error: 'shadow_authority_forbidden', ai_request_path: requestPath, ai_timeout_ms: timeoutMs } }];
  }
  if (!aiEnabled) {
    return [{ json: { ...v3BasePayload, ai_skipped: true, ai_skip_reason: 'disabled', ai_request: null, ai_request_path: requestPath, ai_timeout_ms: timeoutMs } }];
  }
  const v3ConfigError = isPlaceholder(directApiKey) || isPlaceholder(model) ? 'missing_api_config' : null;
  if (v3ConfigError) {
    return [{ json: { ...v3BasePayload, ai_skipped: false, ai_request: null, ai_request_error: v3ConfigError, ai_request_path: requestPath, ai_timeout_ms: timeoutMs } }];
  }
  const repairRequest = parseJsonObject(row.ai_repair_request);
  const hasRepairRequest = Object.keys(repairRequest).length > 0;
  const repairRequestValid = !hasRepairRequest || (
    repairRequest.schema === 'ai_conversation_repair_request/v3'
      && repairRequest.policy_digest === turnPolicy.policy_digest
      && repairRequest.complete_repair === true
      && repairRequest.repair_attempt === 1
      && Array.isArray(repairRequest.errors)
      && repairRequest.errors.length > 0
  );
  if (!repairRequestValid) {
    return [{ json: { ...v3BasePayload, ai_skipped: false, ai_request: null, ai_request_error: 'invalid_repair_request', ai_request_path: requestPath, ai_timeout_ms: timeoutMs } }];
  }
  const v3SystemPrompt = [
    'Sos la única voz normal de la conversación. Respondé al cliente de forma natural dentro de la policy recibida.',
    'Devolvé exactamente un ai_conversation_proposal/v3 completo y sin propiedades adicionales.',
    'Conservá policy_digest sin cambios. reply_text contiene los bytes exactos propuestos para entrega.',
    'Podés declarar cero o una primary_request; su texto debe estar incluido literalmente en reply_text.',
    'Cada observación debe citar texto exacto y su número de ocurrencia en el mensaje actual.',
    'No calcules offsets, digests, payloads operacionales ni claves de idempotencia: los deriva el sistema.',
    'No uses confidence para autorizar datos. No inventes precios, stock, descuentos, garantías, plazos ni efectos.',
    'Un servicio nunca satisface product y un producto nunca satisface service.',
    'Los objetivos orientan el progreso pero no fijan el orden ni la redacción de tus solicitudes.',
    hasRepairRequest
      ? 'Esta es la única reparación permitida: devolvé una propuesta completa corregida usando la misma policy y los errores estructurados.'
      : null,
  ].filter(Boolean).join('\n');
  const v3UserPrompt = JSON.stringify({
    turn_policy: turnPolicy,
    ...(hasRepairRequest ? { repair_request: repairRequest } : {}),
  });
  const v3Request = usesChatCompletions
    ? {
        model,
        messages: [
          { role: 'system', content: `${v3SystemPrompt}\nDevolvé solo JSON válido. No uses Markdown.` },
          { role: 'user', content: v3UserPrompt },
        ],
        temperature: Number($env.AI_DIRECT_API_TEMPERATURE || 0.05),
        max_tokens: Number($env.AI_DIRECT_API_MAX_TOKENS || 1600),
        ...(provider === 'nvidia' ? {} : { response_format: { type: 'json_object' } }),
      }
    : {
        model,
        input: [
          { role: 'system', content: v3SystemPrompt },
          { role: 'user', content: v3UserPrompt },
        ],
        text: {
          format: {
            type: 'json_schema',
            name: 'ai_conversation_proposal_v3',
            schema: v3ResponseSchema,
            strict: true,
          },
        },
        temperature: Number($env.AI_DIRECT_API_TEMPERATURE || 0.05),
        store: false,
      };
  return [{
    json: {
      ...v3BasePayload,
      ai_skipped: false,
      ai_request: v3Request,
      ai_request_chars: JSON.stringify(v3Request).length,
      ai_request_path: requestPath,
      ai_timeout_ms: timeoutMs,
    },
  }];
}
const rawCommercialContext = parseJsonObject(row.commercial_context);
const commercialContext = compactCommercialContext(rawCommercialContext);
const commercialContextCounts = {
  catalog_items: arrayCount(rawCommercialContext.catalog_items),
  conditions: arrayCount(rawCommercialContext.conditions),
  faqs: arrayCount(rawCommercialContext.faqs),
  objections: arrayCount(rawCommercialContext.objections),
  available_slots: arrayCount(rawCommercialContext.available_slots),
};
const hasCommercialContext = Object.values(commercialContextCounts).some((count) => count > 0);

const currentContext = {
  message_current: safe(pickMerged(row.message_current, row.message_current_1, row.text_body, row.text_body_1)),
  message_type: safe(pickMerged(row.message_type, row.message_type_1), 'text'),
  conversation_status: safe(pickMerged(
    row.conversation_status_code,
    row.conversation_status_code_1,
    row.conversation_status,
    row.conversation_status_1
  )),
  current_step: safe(pickMerged(row.current_step, row.current_step_1)),
  existing_fields: {
    service: safe(pickMerged(row.service, row.service_1)),
    city: safe(pickMerged(row.city, row.city_1)),
    requirement: safe(pickMerged(row.requirement, row.requirement_1)),
  },
  qualification_context: compactObject(pickMerged(row.qualification_context, row.qualification_context_1)),
  pending_question_key: safe(pickMerged(row.pending_question_key, row.pending_question_key_1), 'none'),
  previous_lead: compactObject(pickMerged(row.previous_lead, row.previous_lead_1)),
  recent_messages: parseRecentMessages(pickMerged(row.recent_messages, row.recent_messages_1)),
  commercial_context: commercialContext,
  commercial_context_counts: commercialContextCounts,
};

const responseSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'intent',
    'lead_quality',
    'service',
    'city',
    'requirement',
    'missing_fields',
    'confirmation_status',
    'should_create_lead',
    'needs_confirmation',
    'confidence',
    'reply_text',
    'clickup_summary',
    'customer_type',
    'lead_class',
    'modality',
    'diagnostic_datos',
    'commercial_missing_fields',
    'objection_detected',
    'escalation_area',
    'escalation_reason',
    'executive_summary',
    'explicitly_mentioned_fields',
    'field_updates',
    'answered_question_key',
    'next_question_key',
    'advisor_reasoning_summary',
  ],
  properties: {
    intent: {
      type: 'string',
      enum: [
        'greeting',
        'quote_request',
        'provide_info',
        'price_inquiry',
        'delivery_inquiry',
        'installation_inquiry',
        'stock_inquiry',
        'payment_method',
        'payment_proof',
        'invoice_request',
        'warranty_inquiry',
        'complaint',
        'post_sale',
        'reschedule_delivery',
        'reschedule_installation',
        'b2b_request',
        'purchase_order',
        'debris_removal',
        'plant_pickup',
        'competitor_comparison',
        'discount_request',
        'returning_customer',
        'review',
        'talk_to_human',
        'correction',
        'confirmation_yes',
        'confirmation_no',
        'new_request',
        'continue_previous',
        'irrelevant',
        'unknown',
      ],
      description: 'Intencion principal del mensaje actual.',
    },
    lead_quality: {
      type: 'string',
      enum: ['none', 'low', 'medium', 'high'],
      description: 'Calidad comercial del lead segun intencion, datos y urgencia.',
    },
    customer_type: {
      type: 'string',
      enum: ['unknown', 'b2c', 'contractor', 'b2b', 'returning_customer', 'post_sale', 'complaint'],
      description: 'Tipo de cliente detectado. Usar b2b para constructora, empresa, OC, factura o volumen.',
    },
    lead_class: {
      type: 'string',
      enum: ['none', 'A', 'B', 'C', 'D', 'post_sale', 'complaint', 'general'],
      description: 'Clasificacion comercial Hormiglass. A=alta prioridad, B=oportunidad clara, C=exploratoria, D=B2B.',
    },
    modality: {
      type: 'string',
      enum: ['unknown', 'material', 'pickup', 'delivery', 'installation', 'post_sale', 'claim'],
      description: 'Modalidad principal solicitada: solo material (incluye "suministro" o "solo material"), retiro, despacho, instalacion, postventa o reclamo.',
    },
    sales_stage: {
      type: 'string',
      enum: ['greeting', 'exploration', 'qualification', 'recommendation', 'objection', 'quote', 'agenda', 'confirmation', 'ready_for_sales', 'not_qualified'],
      description: 'Etapa comercial sugerida para la conversacion.',
    },
    buying_intent: {
      type: 'string',
      enum: ['low', 'medium', 'high'],
      description: 'Intencion de compra estimada.',
    },
    urgency: {
      type: 'string',
      enum: ['low', 'medium', 'high'],
      description: 'Urgencia estimada del requerimiento.',
    },
    service: {
      type: 'string',
      description: 'Producto o servicio detectado. Usar cadena vacia si no hay evidencia suficiente.',
    },
    city: {
      type: 'string',
      description: 'Ciudad detectada. Usar cadena vacia si no hay evidencia suficiente.',
    },
    requirement: {
      type: 'string',
      description: 'Necesidad concreta detectada. Usar cadena vacia si no hay evidencia suficiente.',
    },
    missing_fields: {
      type: 'array',
      items: {
        type: 'string',
        enum: ['service', 'city', 'requirement', 'confirmation'],
      },
      description: 'Campos minimos actuales que aun faltan para derivar a ventas.',
    },
    commercial_missing_fields: {
      type: 'array',
      items: {
        type: 'string',
        enum: ['name', 'product', 'commune', 'quantity', 'measurements', 'modality', 'urgency', 'photos', 'terrain', 'access', 'debris_removal', 'company', 'rut', 'contact', 'email', 'oc', 'invoice', 'payment_validation', 'human_review', 'address', 'access_restrictions', 'desired_date', 'reception_contact', 'issue_description', 'payment_amount', 'payment_method', 'sale_number', 'purchase_date', 'quote_number'],
      },
      description: 'Datos comerciales/operativos faltantes segun el PRD Hormiglass.',
    },
    diagnostic_datos: {
      type: 'object',
      additionalProperties: false,
      required: ['pain', 'scope', 'timing', 'obstacle', 'next_step'],
      properties: {
        pain: { type: 'string', description: 'Dolor o resultado que busca el cliente.' },
        scope: { type: 'string', description: 'Alcance: producto, cantidad, medidas, modalidad o uso.' },
        timing: { type: 'string', description: 'Tiempo, urgencia o fecha objetivo.' },
        obstacle: { type: 'string', description: 'Objecion o friccion detectada.' },
        next_step: { type: 'string', description: 'Siguiente microaccion recomendada.' },
      },
    },
    confirmation_status: {
      type: 'string',
      enum: ['none', 'requested', 'confirmed', 'rejected'],
      description: 'Estado de confirmacion explicita de los datos por parte del usuario.',
    },
    should_create_lead: {
      type: 'boolean',
      description: 'Decision conversacional de Hormi Atencion. Solo true con datos completos y confirmacion explicita.',
    },
    needs_confirmation: {
      type: 'boolean',
      description: 'true si falta confirmar datos o si la confianza no permite avanzar.',
    },
    confidence: {
      type: 'number',
      minimum: 0,
      maximum: 1,
      description: 'Confianza global entre 0 y 1.',
    },
    per_field_confidence: {
      type: 'object',
      additionalProperties: false,
      properties: {
        service: { type: 'number', minimum: 0, maximum: 1, description: 'Confianza en el campo service.' },
        city: { type: 'number', minimum: 0, maximum: 1, description: 'Confianza en el campo city.' },
        requirement: { type: 'number', minimum: 0, maximum: 1, description: 'Confianza en el campo requirement.' },
      },
      description: 'Confianza por campo individual. Si un campo tiene >0.8, avanza sin preguntar. Si <0.8, pregunta confirmacion de ese campo.',
    },
    reply_text: {
      type: 'string',
      description: 'Respuesta breve sugerida en espanol neutro.',
    },
    catalog_matches: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          sku: { type: 'string' },
          name: { type: 'string' },
          reason: { type: 'string' },
        },
      },
      description: 'Productos o servicios del catalogo oficial que coinciden con la necesidad.',
    },
    price_context: {
      type: 'object',
      additionalProperties: false,
      properties: {
        type: { type: 'string', enum: ['none', 'fixed', 'reference', 'from', 'range', 'requires_human'] },
        currency: { type: 'string' },
        amount: { type: 'number' },
        amount_min: { type: 'number' },
        amount_max: { type: 'number' },
        unit: { type: 'string' },
        requires_validation: { type: 'boolean' },
        explanation: { type: 'string' },
      },
      description: 'Contexto de precio basado solo en reglas oficiales entregadas.',
    },
    objection_detected: {
      type: 'string',
      enum: ['none', 'price', 'competitor', 'thinking', 'urgency', 'stock', 'discount', 'payment', 'warranty', 'technical', 'other'],
      description: 'Objecion principal detectada, si existe.',
    },
    escalation_area: {
      type: 'string',
      enum: ['none', 'sales', 'b2b', 'finance', 'post_sale', 'claims', 'scheduling', 'management'],
      description: 'Area humana recomendada si corresponde derivar.',
    },
    escalation_reason: {
      type: 'string',
      description: 'Razon detallada de por que se requiere escalacion. Usar cadena vacia si escalation_area es none.',
    },
    next_best_action: {
      type: 'string',
      enum: ['ask_data', 'recommend_product', 'answer_question', 'handle_objection', 'quote_reference', 'offer_agenda', 'confirm', 'handoff_sales', 'handoff_b2b', 'handoff_finance', 'handoff_post_sale', 'handoff_claims', 'close_not_qualified'],
      description: 'Siguiente accion recomendada.',
    },
    handoff_reason: {
      type: 'string',
      description: 'Motivo de derivacion a humano si corresponde.',
    },
    executive_summary: {
      type: 'string',
      description: 'Resumen breve y util para la ejecutiva humana, aunque aun no exista lead confirmado.',
    },
    clickup_summary: {
      type: 'string',
      description: 'Resumen corto para ClickUp; vacio si no hay lead confirmado.',
    },
    explicitly_mentioned_fields: {
      type: 'array',
      items: {
        type: 'string',
        enum: ['service', 'city', 'requirement', 'product'],
      },
      description: 'Lista de campos que el usuario menciono explicitamente en su mensaje actual. Incluye product cuando el cliente nombra material (hormigon, losas, adoquines, etc.).',
    },
    field_updates: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: ['string', 'null'] }, product: { type: ['string', 'null'] },
        commune: { type: ['string', 'null'] }, quantity: { type: ['string', 'null'] },
        measurements: { type: ['string', 'null'] }, use_case: { type: ['string', 'null'] },
        modality: { type: ['string', 'null'] }, urgency: { type: ['string', 'null'] },
        desired_date: { type: ['string', 'null'] }, photos: { type: ['boolean', 'null'] },
        terrain: { type: ['string', 'null'] }, truck_access: { type: ['boolean', 'null'] },
        debris_removal: { type: ['boolean', 'null'] }, customer_type: { type: ['string', 'null'] },
        company: { type: ['string', 'null'] }, company_rut: { type: ['string', 'null'] },
        contact_name: { type: ['string', 'null'] }, contact_role: { type: ['string', 'null'] },
        email: { type: ['string', 'null'] }, purchase_order: { type: ['boolean', 'null'] },
        invoice_required: { type: ['boolean', 'null'] }, address: { type: ['string', 'null'] },
        access_restrictions: { type: ['string', 'null'] }, reception_contact: { type: ['string', 'null'] },
        sale_number: { type: ['string', 'null'] }, purchase_date: { type: ['string', 'null'] },
        issue_description: { type: ['string', 'null'] }, payment_amount: { type: ['string', 'null'] },
        payment_method: { type: ['string', 'null'] }, quote_number: { type: ['string', 'null'] },
      },
      description: 'Solo datos nuevos o corregidos con evidencia directa en el mensaje actual.',
    },
    answered_question_key: {
      type: 'string',
      enum: ['none', 'need', 'product', 'commune', 'modality', 'quantity', 'measurements', 'use_case', 'terrain', 'truck_access', 'debris_removal', 'urgency', 'photos', 'customer_type', 'company', 'company_rut', 'contact', 'email', 'purchase_order', 'invoice', 'address', 'desired_date', 'access_restrictions', 'issue_description', 'payment_details', 'final_confirmation', 'anything_else'],
    },
    next_question_key: {
      type: 'string',
      enum: ['none', 'need', 'product', 'commune', 'modality', 'quantity', 'measurements', 'use_case', 'terrain', 'truck_access', 'debris_removal', 'urgency', 'photos', 'customer_type', 'company', 'company_rut', 'contact', 'email', 'purchase_order', 'invoice', 'address', 'desired_date', 'access_restrictions', 'issue_description', 'payment_details', 'final_confirmation', 'anything_else'],
    },
    advisor_reasoning_summary: {
      type: 'string',
      description: 'Resumen breve y auditable de por que esta es la mejor siguiente accion. No se muestra al cliente.',
    },
    prd_validated: {
      type: 'boolean',
      description: 'true si reply_text fue generado sin violar reglas PRD (no inventa precio, stock, descuento, etc).',
    },
    enhancement_type: {
      type: 'string',
      enum: ['none', 'greeting', 'objection', 'b2b_redirect', 'price_redirect', 'data_collection', 'confirmation', 'handoff'],
      description: 'Tipo de enhancement conversacional que aplica esta respuesta.',
    },
  },
};

// OpenAI strict JSON Schema requires required[] to match every properties key.
const alignStrictSchema = (schema) => {
  if (!schema || typeof schema !== 'object') return;
  if (schema.type === 'object' && schema.properties) {
    schema.required = Object.keys(schema.properties);
    for (const property of Object.values(schema.properties)) alignStrictSchema(property);
  }
  if (schema.items) alignStrictSchema(schema.items);
};
alignStrictSchema(responseSchema);

const basePayload = {
  ai_provider: provider,
  ai_model: model,
  ai_base_url: baseUrl,
  ai_api_mode: apiMode,
  ai_context: currentContext,
  response_schema: responseSchema,
  commercial_context: commercialContext,
  commercial_context_counts: commercialContextCounts,
};

if (!aiEnabled) {
  return [{
    json: {
      ...basePayload,
      ai_skipped: true,
      ai_skip_reason: 'disabled',
      ai_request: null,
      ai_request_path: requestPath,
      ai_timeout_ms: timeoutMs,
    },
  }];
}

const configError = isPlaceholder(directApiKey) || isPlaceholder(model) ? 'missing_api_config' : null;

if (configError) {
  return [{
    json: {
      ...basePayload,
      ai_skipped: false,
      ai_request: null,
      ai_request_error: configError,
      ai_request_path: requestPath,
      ai_timeout_ms: timeoutMs,
    },
  }];
}

const systemPrompt = [
  'Eres Hormi Atencion, el asesor comercial virtual de Hormiglass, y eres quien conversa directamente con el cliente por WhatsApp.',
  'Tu fuente normativa principal es el PRD Hormiglass v1.0 incluido en estas instrucciones. Si una recomendacion general contradice una regla del PRD, prevalece el PRD.',
  'Tu rol es consultivo: diagnosticas antes de cotizar, orientas al cliente, evitas guerras de precio y preparas la derivacion a una ejecutiva humana.',
  'Responde exclusivamente con un objeto JSON valido que cumpla el JSON Schema solicitado.',
  'Tienes autonomia conversacional para entender intencion, extraer datos, decidir el siguiente paso, redactar respuesta y marcar should_create_lead=true cuando corresponda.',
  'n8n y PostgreSQL ejecutan tus decisiones: persistencia, asignacion, ClickUp y auditoria. Tu salida JSON es el contrato operativo.',
  '',
  '=== PRINCIPIOS COMERCIALES ===',
  '- El cliente no compra productos, compra resultados. Ej: no compra pastelones, compra un patio terminado.',
  '- "Cotizar no es vender. Primero diagnosticamos, despues orientamos y finalmente cotizamos."',
  '- Evita que la conversacion se transforme en guerra de precios. Diagnostica antes de cotizar.',
  '- Usa lenguaje de valor: "Te ayudo a elegir bien", "Para cotizarte correctamente...", "Lo importante es comparar el proyecto completo, no solo el precio inicial."',
  '- Frase cultural: "Lo barato mal instalado puede salir caro."',
  'Reglas obligatorias:',
  '- No inventes datos. Usa cadena vacia cuando no haya evidencia textual o contexto existente suficiente.',
  '- Si confidence es menor a 0.75, no propongas campos nuevos: deja service, city y requirement vacios salvo datos existentes en el contexto.',
  '- should_create_lead solo puede ser true cuando servicio, ciudad, requerimiento y confirmacion explicita esten presentes.',
  '- Si detectas frustracion (el usuario se queja, pide hablar con alguien, dice que no lo escuchas, insulta o expresa molestia), marca escalation_area distinto de none, pon escalation_reason descriptivo y usa executive_summary para que la ejecutiva entienda el contexto.',
  "- Si el usuario pide explicitamente hablar con una persona (talk_to_human), marca escalation_area='sales', escalation_reason='customer_requested_human_contact' y usa executive_summary para resumir lo conversado.",
  '- Si falta confirmacion, usa confirmation_status=requested o none, missing_fields debe incluir confirmation y should_create_lead=false.',
  '- Si el usuario confirma explicitamente datos completos, usa confirmation_status=confirmed e intent=confirmation_yes.',
  '- Solo interpreta si/no como confirmacion comercial cuando pending_question_key=final_confirmation.',
  '- Si pending_question_key identifica un dato booleano, si/no responde ese dato y NO rechaza ni confirma toda la solicitud.',
  '- Un no ante debris_removal, photos, truck_access, invoice, purchase_order o anything_else nunca borra el contexto.',
  '- Reinicia la solicitud solo ante una peticion explicita de empezar de nuevo.',
  '- Si el usuario corrige un dato, usa intent=correction y devuelve solo datos sustentados por el mensaje o contexto.',
  '- reply_text debe ser breve, claro, natural y en espanol de Chile, sin exagerar modismos.',
  '- Haz una sola pregunta principal por turno. Puedes explicar brevemente el motivo antes de preguntar.',
  '- No repitas preguntas ya respondidas ni vuelvas a pedir datos presentes en existing_fields o recent_messages.',
  '- NUNCA vuelvas a preguntar por el producto si el cliente ya lo menciono (baldosas, adoquines, hormigon, losas, vigas, muros, cierres, etc.). El nombre del material es suficiente para avanzar; no se pide SKU ni codigo de catalogo.',
  '- conversation-flow-v2: Recibes los ultimos 3-4 mensajes de la conversacion como contexto en recent_messages. Usalos para mantener continuidad conversacional.',
  '- conversation-flow-v2: Por cada campo (service, city, requirement), asigna una confianza individual en per_field_confidence. Si >0.8, el sistema avanza sin preguntar. Si <0.8, se preguntara confirmacion de ese campo especifico.',
  '- Si faltan varios datos, prioriza el siguiente dato que mas ayuda a diagnosticar segun D.A.T.O.S. y el tipo de solicitud.',
  '- clickup_summary debe quedar vacio si el lead no esta confirmado.',
  '- Actua como asesor comercial consultivo: diagnostica antes de cotizar.',
  '- Usa el metodo D.A.T.O.S.: dolor, alcance, tiempo, obstaculo y siguiente paso.',
  '- Clasifica el lead segun PRD Hormiglass:',
  '- Lead A: instalacion, proyecto sobre $2.000.000, cierre completo, obra con urgencia, alta intencion de compra, cliente pide visita o instalacion.',
  '- Lead B: venta de material sobre $500.000, cliente con medidas, cliente pide despacho, intencion clara de compra.',
  '- Lead C: venta menor, consulta de precio, cliente explorando, poca urgencia, cantidad pequena.',
  '- Lead D: constructora, empresa, contratista grande, licitacion, Orden de Compra, compra por volumen.',
  '- Postventa: cliente que ya compro, requiere seguimiento.',
  '- Reclamo: cliente con problema o queja.',
  '- Detecta modalidad: material, retiro, despacho, instalacion, postventa o reclamo.',
  '- Deriva a humano cuando: cliente pide ejecutiva, cliente molesto, reclamo, garantia, B2B, OC, descuento, condicion especial de pago, instalacion compleja, proyecto sobre $2.000.000, urgencia alta, comprobante de pago, factura, requiere programacion, cambio de fecha, despacho comprometido, confirmacion de stock real, cliente envia fotos para evaluacion, cliente escribe mas de 2 veces sin quedar resuelto.',
  '- Puedes usar catalogo y precios publicos solo cuando aparezcan en commercial_context.',
  '- No inventes precios, stock, descuentos, garantias, plazos, despacho, instalacion ni agenda.',
  '- Para consultas de stock, responde: "Puedo levantar tu solicitud, pero la disponibilidad debe confirmarla el equipo antes de cerrar la venta."',
  '- Para consultas de instalacion, responde: "Para instalacion necesitamos revisar medidas, comuna, terreno, acceso y si hay retiro de escombros. Con eso se puede preparar una cotizacion mas precisa."',
  '- No valides pagos. Ante comprobantes, responde: "Recibimos el comprobante. La validacion final del pago la realiza Finanzas una vez que el monto este acreditado. Te avisaremos cuando quede confirmado."',
  '- Si un precio requiere medidas, stock o validacion, presentalo como referencial y pide los datos faltantes.',
  '- Si el cliente pregunta por condiciones, descuentos, garantia, despacho, instalacion o agenda y no hay fuente oficial en commercial_context, deriva a un vendedor o pide validar con el equipo.',
  '',
  '=== CLASIFICACION PRODUCTO vs SERVICIO ===',
  'Los unicos SERVICIOS reales son: instalacion, retiro de escombros, suministro (solo material) y despacho.',
  'TODO lo demas es PRODUCTO (material): hormigon, hormigon armado, losas, vigas, muros, losetas, cierres/cierros, adoquines, baldosas, solerillas, bloques, cemento, pigmento, cuarzo, etc.',
  '- "Hormigon Armado Losa" es UN PRODUCTO (nombre de material), no un servicio: ve el material ANTES que cualquier supuesta modalidad.',
  '- Si el cliente menciona producto SIN evidencia de servicio (instalacion/despacho/retiro), no infieras modalidad: deja modality=unknown y pregunta la modalidad.',
  '- "suministro", "solo material" y "solo el material" => modality=material.',
  '- Un producto NUNCA satisface un servicio y un servicio tampoco satisface el campo product.',
  '- No pidas el producto dos veces: la mencion del cliente completa el campo.',
  '- Si el mensaje solo trae producto (p. ej. "Necesito cotizar baldosas"), intent=quote_request y NO installation_inquiry ni delivery_inquiry por el solo hecho de pedir cotizacion.',
  '',
  '=== IA COMO VOZ PRINCIPAL ===',
  'Genera SIEMPRE un reply_text que sea la mejor respuesta al mensaje del cliente.',
  'reply_text debe ser la respuesta completa, clara y en espanol que el cliente deberia recibir.',
  'reply_text debe seguir el estilo consultivo y comercial de Hormiglass.',
  'Nunca devuelvas reply_text vacio salvo que el intent sea irrelevant.',
  'No describas procesos internos, campos JSON, clasificaciones ni guardrails al cliente.',
  'Cuando corresponda derivar, explica el siguiente paso con transparencia y sin prometer tiempos de contacto.',
  'Antes de preguntar, reconoce de forma natural la informacion nueva y aporta una orientacion comercial breve.',
  'Evita entusiasmo artificial como "excelente eleccion" si no existe una razon concreta.',
  'No hagas listas de preguntas. Formula una sola pregunta principal por turno.',
  'Usa field_updates para devolver exclusivamente los datos nuevos o corregidos del mensaje actual.',
  'answered_question_key debe reflejar pending_question_key cuando el cliente lo respondio.',
  'next_question_key debe identificar la unica pregunta principal contenida en reply_text, o none si no preguntas.',
  'advisor_reasoning_summary explica en una frase la decision comercial sin exponer razonamiento interno detallado.',
  '',
  '=== DETECCION B2B ===',
  'Detecta senales B2B en el mensaje:',
  '- Palabras clave: constructora, inmobiliaria, empresa, licitacion, OC, orden de compra,',
  '  proyecto, obra, supervisor, jefe de obra, compras, factura, pago a 30 dias, proveedor,',
  '  volumen, cotizacion formal, RUT empresa.',
  '- Cuando detectes B2B (customer_type=b2b o lead_class=D):',
  '  1. Responde solicitando: empresa, RUT, obra, comuna, producto, cantidad, plazo,',
  '     si tienen OC y condicion de pago.',
  '  2. No trates como cliente particular.',
  '  3. Si hay condicion especial de pago, marca escalation_area="b2b".',
  '',
  '=== SALUDO PERSONALIZADO PARA RECONTACTO ===',
  'Si el mensaje es solo un saludo (hola, buenas, etc.) y ya existen datos en',
  'existing_fields (service, city o requirement):',
  '  - Personaliza el saludo mencionando el contexto anterior.',
  '  - Ejemplo: "Hola! Vi que antes consultaste por [service] en [city]. En que te puedo ayudar?"',
  'Si es el primer contacto sin datos previos:',
  '  - Usa el saludo estandar de Hormiglass.',
  '',
  '=== CLASIFICACION DE LEADS ===',
  'Clasifica SIEMPRE el lead segun criterios PRD Hormiglass:',
  '- Lead A: instalacion, proyecto sobre 2.000.000 CLP, cierre completo, obra con urgencia,',
  '  alta intencion, cliente pide visita o instalacion.',
  '- Lead B: material sobre 500.000 CLP, cliente con medidas, pide despacho, intencion clara.',
  '- Lead C: venta menor, consulta precio, explorando, poca urgencia, cantidad pequena.',
  '- Lead D: constructora, empresa, contratista grande, licitacion, OC, compra por volumen.',
  'Asigna lead_class siempre que tengas datos suficientes.',
  '',
  '=== REGLAS DE RESPUESTA POR INTENCION ===',
  'Para price_inquiry: responde indicando que el precio depende de producto, cantidad,',
  '  comuna y modalidad. Nunca des un monto exacto sin price_context oficial.',
  'Para stock_inquiry: responde "Puedo levantar tu solicitud, pero la disponibilidad',
  '  debe confirmarla el equipo antes de cerrar la venta."',
  'Para installation_inquiry: responde explicando que se necesitan revisar medidas,',
  '  comuna, terreno, acceso y si hay retiro de escombros.',
  'Para delivery_inquiry: responde que se necesita comuna, producto, cantidad y',
  '  fecha tentativa para revisar factibilidad.',
  'Para payment_proof: responde que el comprobante sera validado por Finanzas.',
  'Para warranty_inquiry: responde que la garantia se revisa por caso.',
  'Para competitor_comparison: responde sugiriendo comparar costo total no solo precio.',
  'Para discount_request: responde que condiciones especiales las revisa una ejecutiva.',
  '',
  '=== RECONOCIMIENTO DE INTENCIONES ===',
  'Reconoce al menos estas 25 intenciones y 10 adicionales. Usa intent segun corresponda:',
  '- saludo inicial -> greeting',
  '- cotizar producto / saber precio -> quote_request',
  '- consultar precio -> price_inquiry',
  '- consultar despacho -> delivery_inquiry',
  '- consultar instalacion -> installation_inquiry',
  '- consultar stock -> stock_inquiry',
  '- consultar horarios / direccion -> provide_info',
  '- consultar formas de pago -> payment_method',
  '- enviar comprobante de pago -> payment_proof',
  '- solicitar factura -> invoice_request',
  '- consultar garantia -> warranty_inquiry',
  '- reclamo / problema -> complaint',
  '- postventa / seguimiento -> post_sale',
  '- reagendar despacho -> reschedule_delivery',
  '- reagendar instalacion -> reschedule_installation',
  '- solicitud B2B / constructora -> b2b_request',
  '- enviar orden de compra (OC) -> purchase_order',
  '- consultar retiro de escombros -> debris_removal',
  '- consultar retiro en planta -> plant_pickup',
  '- comparar con competencia -> competitor_comparison',
  '- pedir descuento -> discount_request',
  '- cliente antiguo / ya compre antes -> returning_customer',
  '- dejar resena -> review',
  '- hablar con ejecutiva / humano -> talk_to_human',
  '- cliente corrige un dato -> correction',
  '- cliente confirma datos -> confirmation_yes',
  '- cliente rechaza o niega -> confirmation_no',
  '- cliente trae nuevo requerimiento -> new_request',
  '- continuacion de conversacion anterior -> continue_previous',
  '- mensaje irrelevante o sin sentido -> irrelevant',
  '- no se puede determinar -> unknown',
  '',
  '=== DATOS POR TIPO DE SOLICITUD ===',
  'Segun el tipo de solicitud detectado, levanta los campos especificos:',
  '- **Material**: nombre, telefono, producto, cantidad, comuna, retiro/despacho, fecha estimada, tipo cliente.',
  '- **Instalacion**: nombre, telefono, producto, comuna, metros aprox, tipo de terreno, fotos, fecha deseada, retiro de escombros, acceso, tipo lugar.',
  '- **B2B**: empresa, RUT, contacto, cargo, telefono, correo, obra, comuna, producto, cantidad, fecha, OC, condicion pago, documentacion.',
  '- **Despacho**: comuna, direccion, producto, cantidad, fecha tentativa, restricciones acceso, contacto recepcion.',
  '- **Reclamo/Garantia**: nombre, telefono, nro venta, producto, fecha, descripcion, fotos/videos, comuna, urgencia.',
  '- **Pago**: nombre, telefono, monto, medio, comprobante, nro cotizacion o venta.',
  'Usa commercial_missing_fields para marcar cuales faltan.',
  '',
  '=== GATE DE CAMPOS OBLIGATORIOS (PRD SECCIONES 13.1 a 13.8) ===',
  'El sistema bloquea la creacion de leads y la confirmacion final si faltan campos obligatorios de la intencion. Tu reporte de commercial_missing_fields debe coincidir con esta politica:',
  '- Material/venta: obligatorios = producto, modalidad (material/despacho/retiro), cantidad, comuna. Condicionales: fecha estimada, factura.',
  '- Instalacion: obligatorios = producto, cantidad, comuna, terreno, acceso para camion, retiro de escombros. Condicionales: medidas, fotos, fecha.',
  '- Despacho: obligatorios = producto, cantidad, comuna, direccion, restricciones de acceso.',
  '- Retiro en planta: obligatorio = producto. Condicionales: cantidad, fecha de retiro, contacto del retirador.',
  '- B2B: obligatorios = empresa, contacto, producto, cantidad, comuna, OC/orden de compra. Condicionales: RUT, correo, fecha, condicion de pago.',
  '- Reclamo: obligatorio = descripcion del problema. Condicionales: numero de venta, fecha de compra, fotos, urgencia.',
  '- Garantia: obligatorio = descripcion de la solicitud. Condicionales: producto instalado, numero de venta, fecha, fotos.',
  '- Comprobante de pago: obligatorios = monto, medio de pago. Condicionales: adjunto, numero de cotizacion o venta.',
  '- Factura: obligatorio = solicitud de factura. Condicionales: correo, empresa, RUT.',
  'REGLAS DEL GATE:',
  '- name y phone los provee el remitente de WhatsApp; NUNCA los agregues a commercial_missing_fields.',
  '- Si faltan campos obligatorios, NO pongas confirmation_status=confirmed ni should_create_lead=true.',
  'confirmation_status debe ser requested o none y reply_text debe preguntar el primer campo faltante.',
  '- Los campos condicionales NO bloquean: dejarlos fuera de commercial_missing_fields.',
  '',
  '=== RETIRO DE ESCOMBROS ===',
  '- Si modalidad = instalacion, pregunta OBLIGATORIAMENTE por retiro de escombros.',
  '- Agrega debris_removal a commercial_missing_fields.',
  '- Advertir que requiere coordinacion logistica adicional.',
  '',
  '=== MANEJO DE OBJECIONES ===',
  'Usa estos scripts segun la objecion detectada (objection_detected):',
  '',
  'Si objection_detected = price ("esta caro", "muy caro", "mucho"):',
  '  Responde: "Entiendo. Es normal comparar. En estos proyectos lo importante es revisar el costo total: producto, espesor, despacho, instalacion, plazo, garantia y respaldo. A veces una opcion mas barata no incluye todo o puede terminar costando mas si despues hay que corregir."',
  '',
  'Si objection_detected = competitor ("en otro lado mas barato", "competencia"):',
  '  Responde: "Perfecto que compares. Solo asegurate de revisar si ambas cotizaciones incluyen lo mismo: material, medidas, espesor, despacho, instalacion, retiro de escombros, plazo y garantia. Si quieres, te ayudo a ordenar la informacion para que una ejecutiva pueda orientarte mejor."',
  '  No iguales precios ni ofrezcas descuento automaticamente.',
  '',
  'Si objection_detected = thinking ("lo voy a pensar", "lo veo", "lo reviso"):',
  '  Responde: "Esta bien. Para ayudarte a decidir, ¿que punto te falta resolver: precio, plazo, producto, instalacion o confianza?"',
  '',
  'Si objection_detected = urgency ("necesito rapido", "urgencia", "para ayer"):',
  '  Responde: "Entiendo. Para revisar factibilidad necesitamos comuna, producto, cantidad y si es retiro, despacho o instalacion. Prefiero ayudarte a confirmar un plazo realista antes de prometer algo que pueda fallar."',
  '',
  'Si el cliente dice "solo quiero precio" o "solo precio":',
  '  Responde: "Te entiendo. Para darte un precio correcto necesito al menos producto, cantidad aproximada, comuna y modalidad. No es lo mismo solo material que despacho o instalacion."',
  '',
  '=== FORMATO DE RESUMEN PARA EJECUTIVA ===',
  'Cuando debas derivar a humano o tengas datos suficientes, genera executive_summary con:',
  'Cliente: [nombre]',
  'Telefono: [numero]',
  'Tipo de cliente: [B2C/contratista/B2B/antiguo/reclamo]',
  'Clasificacion: [Lead A/B/C/D]',
  'Producto: [producto]',
  'Modalidad: [material/despacho/retiro/instalacion]',
  'Comuna: [comuna]',
  'Cantidad/medidas: [detalle]',
  'Urgencia: [fecha o nivel]',
  'Dolor/necesidad: [que quiere resolver]',
  'Objecion: [precio/competencia/plazo/confianza/ninguna]',
  'Retiro escombros: [Si/No/No informado]',
  'Fotos: [Si/No]',
  'Requiere factura: [Si/No/No informado]',
  'OC: [Si/No/No aplica]',
  'Siguiente paso: [llamar/cotizar/pedir datos/derivar B2B/revisar pago/revisar reclamo]',
  'Comentario: [resumen breve]',
].join('\n');

const systemPromptText = systemPrompt;

const chatContractPrompt = [
  'Contrato JSON obligatorio para Chat Completions:',
  '- Devuelve exactamente un objeto JSON, sin Markdown ni texto extra.',
  '- Incluye siempre estas claves: intent, lead_quality, customer_type, lead_class, modality, service, city, requirement, missing_fields, commercial_missing_fields, diagnostic_datos, confirmation_status, should_create_lead, needs_confirmation, confidence, reply_text, objection_detected, escalation_area, escalation_reason, next_best_action, handoff_reason, executive_summary, clickup_summary, field_updates, answered_question_key, next_question_key, advisor_reasoning_summary.',
  '- intent debe ser uno de: greeting, quote_request, provide_info, price_inquiry, delivery_inquiry, installation_inquiry, stock_inquiry, payment_method, payment_proof, invoice_request, warranty_inquiry, complaint, post_sale, reschedule_delivery, reschedule_installation, b2b_request, purchase_order, debris_removal, plant_pickup, competitor_comparison, discount_request, returning_customer, review, talk_to_human, correction, confirmation_yes, confirmation_no, new_request, continue_previous, irrelevant, unknown.',
  '- lead_quality debe ser uno de: none, low, medium, high.',
  '- customer_type debe ser uno de: unknown, b2c, contractor, b2b, returning_customer, post_sale, complaint.',
  '- lead_class debe ser uno de: none, A, B, C, D, post_sale, complaint, general.',
  '- modality debe ser uno de: unknown, material, pickup, delivery, installation, post_sale, claim.',
  '- confirmation_status debe ser uno de: none, requested, confirmed, rejected.',
  '- missing_fields solo puede contener: service, city, requirement, confirmation.',
  '- confidence debe ser un numero entre 0 y 1. Usa al menos 0.8 si el mensaje contiene claramente servicio y ciudad.',
  '- needs_confirmation debe ser true si falta confirmacion explicita.',
  '- should_create_lead solo puede ser true con confirmacion explicita y datos completos.',
  '- Si pending_question_key no es final_confirmation, una respuesta si/no no puede producir confirmation_yes ni confirmation_no.',
  '- Si tienes datos completos pero falta confirmacion, intent=quote_request, confirmation_status=requested, missing_fields=[\'confirmation\'], should_create_lead=false y reply_text debe pedir confirmacion.',
  '- Si recomiendas un producto, usa catalog_matches con id, sku o name presente en commercial_context.catalog_items.',
  '- Si informas precio, usa price_context basado solo en price_rules de commercial_context.catalog_items.',
  '- prd_validated debe ser true si reply_text no viola reglas PRD.',
  '- enhancement_type debe indicar el tipo de enhancement: greeting, objection, b2b_redirect, price_redirect, data_collection, confirmation, handoff o none.',
].join('\n');

const userPromptPayload = {
  current_context: currentContext,
  commercial_context_available: hasCommercialContext,
  commercial_context_rules: {
    catalog_and_public_prices_loaded: commercialContextCounts.catalog_items > 0,
    conditions_loaded: commercialContextCounts.conditions > 0,
    faq_loaded: commercialContextCounts.faqs > 0,
    objections_loaded: commercialContextCounts.objections > 0,
    agenda_loaded: commercialContextCounts.available_slots > 0,
    policy: 'Usar solo informacion presente en commercial_context. Si falta una fuente, no inventar y derivar o pedir validacion.'
  },
};
if (!usesChatCompletions) userPromptPayload.required_json_schema = responseSchema;
const userPrompt = JSON.stringify(userPromptPayload);
const aiRequest = usesChatCompletions
  ? {
      model,
      messages: [
        { role: 'system', content: systemPromptText + '\n' + chatContractPrompt + '\nDevuelve solo JSON valido. No uses Markdown.' },
        { role: 'user', content: userPrompt },
      ],
      temperature: Number($env.AI_DIRECT_API_TEMPERATURE || 0.05),
      max_tokens: Number($env.AI_DIRECT_API_MAX_TOKENS || 1200),
      ...(provider === 'nvidia' ? {} : { response_format: { type: 'json_object' } }),
    }
  : {
      model,
      input: [
        { role: 'system', content: systemPromptText },
        { role: 'user', content: userPrompt },
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'hormi_lead_qualification_decision',
          schema: responseSchema,
          strict: true,
        },
      },
      temperature: Number($env.AI_DIRECT_API_TEMPERATURE || 0.05),
      store: false,
    };

return [
  {
    json: {
      ...basePayload,
      ai_skipped: false,
      ai_request: aiRequest,
      ai_request_chars: JSON.stringify(aiRequest).length,
      ai_request_path: requestPath,
      ai_timeout_ms: timeoutMs,
    },
  },
];
