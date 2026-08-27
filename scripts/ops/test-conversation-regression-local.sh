#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
cd "$ROOT_DIR"

node <<'NODE'
const fs = require('fs');

(async () => {
const samplePath = 'n8n/samples/conversation_regression_cases.sample.json';
const matrixPath = 'docs/matriz-pruebas-conversacionales.md';
const orchestratorPath = 'n8n/workflows/wa-conversation-orchestrator.json';
const assistantPath = 'n8n/workflows/ai-lead-qualification-assistant.json';
const conversationStatusesSeedPath = 'db/seeds/002_conversation_statuses.sql';
const suite = JSON.parse(fs.readFileSync(samplePath, 'utf8'));
const matrix = fs.readFileSync(matrixPath, 'utf8');
const orchestrator = JSON.parse(fs.readFileSync(orchestratorPath, 'utf8'));
const assistant = JSON.parse(fs.readFileSync(assistantPath, 'utf8'));
const conversationStatusesSeed = fs.readFileSync(conversationStatusesSeedPath, 'utf8');

const requiredEvidence = [
  'conversation_id',
  'lead_id',
  'clickup_task_id',
  'vendedor',
  'auditorias',
];

const requiredBaseCases = Array.from({ length: 12 }, (_, index) =>
  `CP-${String(index + 1).padStart(2, '0')}`
);
const requiredAiCases = ['AI-01', 'AI-02', 'AI-03', 'AI-04', 'AI-05', 'AI-06'];
const requiredGate = ['servicio', 'ciudad', 'requerimiento', 'confirmacion'];

const fail = (message) => {
  throw new Error(message);
};

if (!Array.isArray(suite.cases)) fail('El fixture no define cases[]');
if (!Array.isArray(suite.required_evidence)) fail('El fixture no define required_evidence[]');
if (!Array.isArray(suite.lead_creation_gate)) fail('El fixture no define lead_creation_gate[]');

for (const field of requiredEvidence) {
  if (!suite.required_evidence.includes(field)) {
    fail(`Falta evidencia obligatoria en fixture: ${field}`);
  }
  if (!matrix.includes(field)) {
    fail(`Falta evidencia obligatoria en matriz: ${field}`);
  }
}

for (const gate of requiredGate) {
  if (!suite.lead_creation_gate.includes(gate)) {
    fail(`Falta gate de creacion de lead: ${gate}`);
  }
}

const ids = new Set(suite.cases.map((testCase) => testCase.id));
for (const id of [...requiredBaseCases, ...requiredAiCases]) {
  if (!ids.has(id)) fail(`Falta caso en fixture: ${id}`);
  if (!matrix.includes(id)) fail(`Falta caso en matriz: ${id}`);
}

for (const testCase of suite.cases) {
  if (!testCase.id || !testCase.title) fail('Cada caso debe tener id y title');
  if (!testCase.input || !Array.isArray(testCase.input.messages)) {
    fail(`${testCase.id}: input.messages debe existir`);
  }
  if (!testCase.expected || typeof testCase.expected !== 'object') {
    fail(`${testCase.id}: expected debe existir`);
  }

  const expected = testCase.expected;
  for (const boolField of ['lead_created', 'clickup_task_created', 'confirmed_by_user']) {
    if (typeof expected[boolField] !== 'boolean') {
      fail(`${testCase.id}: expected.${boolField} debe ser boolean`);
    }
  }

  if (expected.clickup_task_created && !expected.lead_created) {
    fail(`${testCase.id}: ClickUp no puede crearse sin lead`);
  }
  if (expected.lead_created && !expected.confirmed_by_user) {
    fail(`${testCase.id}: lead no puede crearse sin confirmacion`);
  }
  if (expected.clickup_task_created && !expected.confirmed_by_user) {
    fail(`${testCase.id}: ClickUp no puede crearse sin confirmacion`);
  }
  if (testCase.id.startsWith('AI-') && expected.ai_creates_lead_directly === true && expected.confirmed_by_user !== true) {
    fail(`${testCase.id}: Hormi Atencion solo puede decidir crear lead con confirmacion`);
  }
  if (testCase.id === 'AI-01' && expected.fallback_deterministic !== true) {
    fail('AI-01 debe caer a fallback deterministico por error de configuracion');
  }
  if (testCase.id === 'AI-03' && expected.fallback_deterministic !== true) {
    fail('AI-03 debe caer a fallback deterministico');
  }
  if (testCase.id === 'AI-04') {
    if (expected.fallback_deterministic !== true) fail('AI-04 debe caer a fallback deterministico');
    if (!Array.isArray(expected.accepted_ai_fields) || expected.accepted_ai_fields.length !== 0) {
      fail('AI-04 no debe aceptar campos AI con baja confianza');
    }
  }
  if (testCase.id === 'AI-05' && expected.explicit_correction_required_to_overwrite !== true) {
    fail('AI-05 debe exigir correccion explicita para sobrescribir campos');
  }
  if (testCase.id === 'AI-06') {
    if (expected.confirmed_by_user !== true || expected.lead_created !== true) {
      fail('AI-06 debe cubrir lead confirmado creado por Hormi Atencion');
    }
    if (expected.ai_creates_lead_directly !== true) {
      fail('AI-06 debe dejar explicita la autonomia confirmada de Hormi Atencion');
    }
  }
}

const applyNode = orchestrator.nodes.find((node) => node.name === 'Apply AI Assistance');
if (!applyNode) fail('Falta nodo Apply AI Assistance en orquestador');

const evaluateNode = orchestrator.nodes.find((node) => node.name === 'Evaluate Conversation Step');
if (!evaluateNode) fail('Falta nodo Evaluate Conversation Step en orquestador');

const loadStateNode = orchestrator.nodes.find((node) => node.name === 'Load Conversation State');
if (!loadStateNode) fail('Falta nodo Load Conversation State en orquestador');
const loadStateQuery = loadStateNode.parameters.query;
if (!loadStateQuery.includes('AS recent_messages')) {
  fail('Load Conversation State debe exponer recent_messages');
}
if (!loadStateQuery.includes("m.direction = 'outgoing' AND m.delivery_status = 'sent'")) {
  fail('El historial solo debe incluir mensajes salientes enviados');
}
if (!loadStateQuery.includes("metadata->>'reset_conversation_lead'")) {
  fail('El historial debe cortarse desde el ultimo reinicio de solicitud');
}
if (!loadStateQuery.includes('ll.previous_lead_created_at > lcr.reset_at')) {
  fail('Un reinicio debe ocultar leads anteriores al nuevo contexto');
}
if (!loadStateQuery.includes('last_persisted_inbound')) {
  fail('Load Conversation State debe basarse en el ultimo inbound persistido');
}
if (!loadStateQuery.includes("lpi.last_inbound_at >= NOW() - INTERVAL '48 hours'")) {
  fail('La continuidad conversacional debe respetar el limite de 48 horas');
}
if (!loadStateQuery.includes("lpi.last_inbound_at >= NOW() - INTERVAL '30 days'")) {
  fail('El re-engagement debe respetar el limite inclusivo de 30 dias');
}
if (!loadStateQuery.includes("lc.conversation_status_code IN ('active', 'waiting_user', 'out_of_flow')")) {
  fail('Solo los estados conversacionales elegibles deben cargarse como contexto activo');
}

const buildAiNode = assistant.nodes.find((node) => node.name === 'Build AI Request');
if (!buildAiNode) fail('Falta nodo Build AI Request en asistente AI');
if (!buildAiNode.parameters.jsCode.includes('PRD Hormiglass v1.0')) {
  fail('El prompt AI debe declarar el PRD Hormiglass como fuente normativa principal');
}
if (!buildAiNode.parameters.jsCode.includes('IA COMO VOZ PRINCIPAL')) {
  fail('El prompt AI debe declarar a la IA como voz principal de la conversacion');
}
if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(buildAiNode.parameters.jsCode + applyNode.parameters.jsCode)) {
  fail('Los nodos AI no deben contener caracteres de control corruptos');
}

const aiLinkNode = orchestrator.nodes.find((node) => node.name === 'Execute AI Lead Qualification');
if (!aiLinkNode || aiLinkNode.type !== 'n8n-nodes-base.executeWorkflow') {
  fail('Falta nodo Execute AI Lead Qualification como executeWorkflow');
}

const persistNode = orchestrator.nodes.find((node) => node.name === 'Persist Conversation State');
if (!persistNode) fail('Falta nodo Persist Conversation State en orquestador');
if (!persistNode.parameters.query.includes('advisor_decision_insert')) {
  fail('Persist Conversation State debe registrar decisiones AI en advisor_decisions');
}
if (!persistNode.parameters.additionalFields.queryParams.includes('catalog_matches_json')) {
  fail('Persist Conversation State debe recibir contexto comercial saneado');
}
if (!persistNode.parameters.additionalFields.queryParams.includes('diagnostic_datos_json')) {
  fail('Persist Conversation State debe recibir diagnostico D.A.T.O.S.');
}
if (!persistNode.parameters.query.includes('resolved_conversation_candidates')) {
  fail('Persist Conversation State debe validar la cardinalidad de la conversacion resuelta');
}
if (!persistNode.parameters.query.includes('CASE WHEN COUNT(*) = 1 THEN MAX(id) ELSE 1 / (COUNT(*) - COUNT(*)) END')) {
  fail('Persist Conversation State debe fallar si no resuelve exactamente una conversacion');
}
if (!conversationStatusesSeed.includes("'escalation_required'")) {
  fail('El seed de estados debe soportar escalaciones genuinas');
}

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

const buildAiFn = new AsyncFunction('items', '$env', buildAiNode.parameters.jsCode);
const builtAi = (await buildAiFn([{ json: {
  text_body: 'Hola', message_type: 'text', current_step: 'city',
  service: '', city: '', requirement: '', recent_messages: [], qualification_context: {},
} }], {
  AI_LEAD_ASSISTANT_ENABLED: 'true', AI_DIRECT_API_KEY: 'test-key', AI_DIRECT_API_MODEL: 'test-model',
}))[0].json;
const assertStrictSchema = (schema, path = 'root') => {
  if (!schema || typeof schema !== 'object') return;
  if (schema.type === 'object' && schema.properties) {
    const propertyKeys = Object.keys(schema.properties).sort();
    const requiredKeys = Array.isArray(schema.required) ? [...schema.required].sort() : [];
    if (JSON.stringify(propertyKeys) !== JSON.stringify(requiredKeys)) {
      fail(`Schema AI required/properties desalineado en ${path}`);
    }
    for (const [key, property] of Object.entries(schema.properties)) assertStrictSchema(property, `${path}.${key}`);
  }
  if (schema.items) assertStrictSchema(schema.items, `${path}[]`);
};
assertStrictSchema(builtAi.response_schema);
if (!builtAi.response_schema.properties.field_updates || !builtAi.response_schema.properties.per_field_confidence) {
  fail('Schema AI debe exponer field_updates y per_field_confidence como objetos de primer nivel');
}
const runApplyAi = async (row, env = {}) => {
  const fn = new AsyncFunction('items', '$env', applyNode.parameters.jsCode);
  const result = await fn([{ json: row }], env);
  return result[0].json;
};
const runEvaluate = async (row) => {
  const fn = new AsyncFunction('items', evaluateNode.parameters.jsCode);
  const normalizedRow = {
    has_existing_conversation: Boolean(
      row.has_existing_conversation ?? row.has_active_conversation ?? row.conversation_id,
    ),
    ...row,
  };
  const result = await fn([{ json: normalizedRow }]);
  return result[0].json;
};
const mergedAiShape = (deterministicRow, aiRow) => ({
  ...aiRow,
  ...Object.fromEntries(Object.entries(deterministicRow).map(([key, value]) => [`${key}_1`, value])),
});

const baseDeterministic = {
  phone_number: 'test-contact-regression-011',
  source_number_id: 1,
  instance_name: 'principal',
  whatsapp_name: 'Cliente Prueba',
  message_type: 'text',
  text_body: 'Necesito cotizar baldosas para renovar un baño en Santiago',
  raw_payload_json: '{}',
  conversation_id: null,
  lead_id: null,
  service: null,
  city: 'Santiago',
  requirement: null,
  current_step: 'service',
  conversation_status_code: 'waiting_user',
  should_create_lead: false,
  is_partial: false,
  response_text: '¿Qué servicio estás buscando?',
  response_kind: 'welcome_and_question',
  normalized_text: 'necesito cotizar baldosas para renovar un bano en santiago',
  completed_fields_count: 1,
  has_intent: true,
  audit_event_name: 'conversation_state_evaluated',
  audit_result: 'waiting_user',
  before_payload_json: '{}',
  after_payload_json: JSON.stringify({ city: 'Santiago', current_step: 'service', should_create_lead: false }),
  metadata_json: '{}',
};

const communeAndProduct = await runEvaluate({
  phone_number: 'test-contact-regression-012',
  message_type: 'text',
  text_body: 'Quiero cotizar 25 metros de adoquines en Las Condes, solo material',
  raw_payload_json: '{}',
  has_active_conversation: false,
  conversation_status_code: null,
  current_step: null,
  state_current_step: null,
  service: null,
  city: null,
  requirement: null,
  lead_id: null,
});
if (communeAndProduct.city !== 'Las Condes') {
  fail('Extractor deterministico debe reconocer la comuna Las Condes');
}
if (communeAndProduct.service !== 'Adoquines') {
  fail('Extractor deterministico debe aislar Adoquines como producto');
}
if (communeAndProduct.current_step !== 'confirm'
    || !String(communeAndProduct.current_step_encoded).startsWith('confirm|')) {
  fail('Mensaje completo con comuna y producto debe pasar a confirmacion');
}

const adoquinRequest = await runEvaluate({
  phone_number: 'test-contact-regression-015',
  message_type: 'text',
  text_body: 'Necesito suministro de adoquines',
  raw_payload_json: '{}',
  has_active_conversation: true,
  conversation_status_code: 'waiting_user',
  current_step: 'city',
  state_current_step: 'city',
});
if (adoquinRequest.service !== 'Adoquines') {
  fail('Producto explicito no debe confundirse con una respuesta de ciudad');
}
const adoquinCity = await runEvaluate({
  phone_number: 'test-contact-regression-015',
  message_type: 'text',
  text_body: 'Quilicura',
  raw_payload_json: '{}',
  has_active_conversation: true,
  conversation_status_code: 'waiting_user',
  current_step: adoquinRequest.current_step,
  state_current_step: adoquinRequest.current_step,
  state_service: adoquinRequest.service,
  state_requirement: adoquinRequest.requirement,
});
if (adoquinCity.service !== 'Adoquines' || adoquinCity.city !== 'Quilicura') {
  fail('El fallback debe conservar adoquines y agregar Quilicura en el turno siguiente');
}

const preservedHistory = await runEvaluate({
  phone_number: 'test-contact-regression-013',
  message_type: 'text',
  text_body: 'Santiago',
  raw_payload_json: '{}',
  has_active_conversation: true,
  conversation_status_code: 'waiting_user',
  current_step: 'city',
  state_current_step: 'city',
  recent_messages: [
    { role: 'user', content: 'Quiero cotizar solerillas' },
    { role: 'assistant', content: '¿En que comuna las necesitas?' },
  ],
});
if (!Array.isArray(preservedHistory.recent_messages) || preservedHistory.recent_messages.length !== 2) {
  fail('Evaluate Conversation Step debe propagar el historial vigente');
}

const resetHistory = await runEvaluate({
  phone_number: 'test-contact-regression-014',
  message_type: 'text',
  text_body: 'Iniciar una nueva',
  raw_payload_json: '{}',
  has_active_conversation: false,
  conversation_status_code: null,
  current_step: null,
  state_current_step: null,
  previous_lead_id: 99,
  previous_service: 'Baldosas',
  previous_city: 'Santiago',
  previous_requirement: 'Patio',
  qualification_context: {
    measurements: '40 m2',
    modality: 'installation',
    company: 'Empresa antigua',
  },
  recent_messages: [
    { role: 'user', content: 'Quiero continuar lo anterior' },
    { role: 'assistant', content: '¿Quieres continuar o iniciar una nueva?' },
  ],
});
if (resetHistory.reset_conversation_lead !== true) {
  fail('Iniciar una nueva solicitud debe marcar reset_conversation_lead');
}
if (!Array.isArray(resetHistory.recent_messages) || resetHistory.recent_messages.length !== 0) {
  fail('El turno que reinicia la solicitud debe vaciar recent_messages');
}
const resetWithoutSilentReuse = await runApplyAi(mergedAiShape(resetHistory, {
  ai_skipped_1: false,
  intent_1: 'new_request',
  confidence: 0.95,
  service: 'Baldosas',
  city: 'Santiago',
  requirement: 'Patio',
  explicitly_mentioned_fields: [],
  field_updates: {
    measurements: '40 m2',
    modality: 'installation',
    company: 'Empresa antigua',
  },
  diagnostic_datos: {
    scope: 'Contexto antiguo',
  },
  customer_type: 'b2b',
  lead_class: 'D',
  reply_text: 'Perfecto, iniciemos una nueva solicitud. ¿En qué ciudad necesitas cotizar?',
}));
if (resetWithoutSilentReuse.service || resetWithoutSilentReuse.city || resetWithoutSilentReuse.requirement) {
  fail('Una nueva solicitud no debe reutilizar silenciosamente campos sugeridos por AI');
}
if (
  Object.keys(resetWithoutSilentReuse.qualification_context).length !== 0
  || resetWithoutSilentReuse.qualification_context_json !== '{}'
) {
  fail('Una nueva solicitud debe limpiar measurements, modality, company y todo qualification_context anterior');
}

const configError = await runApplyAi(
  mergedAiShape(baseDeterministic, {
    ai_skipped_1: false,
    ai_request_error_1: 'missing_api_config',
    ai_fallback_reason_1: 'missing_api_config',
    service: 'Baldosas',
    requirement: 'Renovar un baño',
    confidence: 0.92,
  })
);
if (configError.ai_applied !== false) fail('Config AI invalida no debe aplicar campos');
if (configError.service !== null || configError.requirement !== null) fail('Config AI invalida cambio campos determinísticos');
if (configError.ai_fallback_reason !== 'missing_api_config') fail('Config AI invalida debe exponer fallback correcto');

const validAi = await runApplyAi(mergedAiShape(baseDeterministic, {
  ai_skipped_1: false,
  intent_1: 'quote_request',
  service: 'Baldosas',
  city: 'Santiago',
  requirement: 'Renovar un baño',
  confirmation_status: 'requested',
  confidence: 0.92,
  should_create_lead: true,
  lead_quality: 'medium',
  customer_type: 'b2c',
  lead_class: 'A',
  modality: 'installation',
  sales_stage: 'qualification',
  buying_intent: 'medium',
  urgency: 'low',
  diagnostic_datos: {
    pain: 'Renovar baño',
    scope: 'Baldosas con instalacion por revisar',
    timing: 'No informado',
    obstacle: 'Faltan medidas',
    next_step: 'Pedir confirmacion y datos de instalacion',
  },
  commercial_missing_fields: ['measurements', 'photos'],
  objection_detected: 'none',
  escalation_area: 'sales',
  catalog_matches: [{ id: 'item-1', sku: 'BAL-001', name: 'Baldosa', reason: 'producto mencionado' }],
  price_context: { type: 'reference', currency: 'CLP', amount: 12990, unit: 'm2', requires_validation: true },
  next_best_action: 'quote_reference',
  executive_summary: 'Cliente B2C solicita baldosas en Santiago; faltan medidas y fotos.',
  metadata_json: JSON.stringify({ commercial_context_counts: { catalog_items: 1, price_rules: 1 } }),
}));
if (validAi.ai_applied !== true) fail('AI valida debio asistir extraccion');
if (validAi.service !== 'Baldosas' || validAi.requirement !== 'Renovar un baño') fail('AI valida no mezclo campos esperados');
if (validAi.should_create_lead !== false) fail('Hormi Atencion no puede crear lead sin confirmacion');
if (!String(validAi.current_step).startsWith('confirm|')) fail('AI valida con campos completos debe pedir confirmacion');
if (validAi.sales_stage !== 'qualification' || validAi.buying_intent !== 'medium') {
  fail('AI valida debe conservar etapa e intencion comercial saneadas');
}
if (validAi.customer_type !== 'b2c' || validAi.lead_class !== 'A' || validAi.modality !== 'installation') {
  fail('AI valida debe conservar tipo de cliente, clasificacion y modalidad PRD');
}
if (!String(validAi.diagnostic_datos_json).includes('Renovar baño')) {
  fail('AI valida debe exponer diagnostico D.A.T.O.S. para auditoria');
}
const validCommercialMissing = JSON.parse(validAi.commercial_missing_fields_json);
if (!['modality', 'quantity'].every((field) => validCommercialMissing.includes(field))) {
  fail('AI valida debe exponer modalidad y cantidad como obligatorios del perfil material');
}
if (validCommercialMissing.includes('terrain') || validCommercialMissing.includes('access') || validCommercialMissing.includes('debris_removal')) {
  fail('La modalidad sin evidencia de instalacion no debe activar campos de instalacion');
}
if (validCommercialMissing.includes('measurements') || validCommercialMissing.includes('photos')) {
  fail('Campos condicionales de instalacion no deben bloquear la confirmacion comercial');
}
const validAiMetadata = JSON.parse(validAi.metadata_json);
if (!['measurements', 'photos'].every((field) => validAiMetadata.ai_commercial_missing_fields.includes(field))) {
  fail('El diagnostico AI de campos condicionales debe conservarse separado para auditoria');
}
if (validAi.escalation_area !== 'sales' || !String(validAi.executive_summary).includes('Tipo de cliente: b2c')) {
  fail('AI valida debe conservar escalamiento y resumen ejecutivo');
}
if (!String(validAi.catalog_matches_json).includes('BAL-001')) {
  fail('AI valida debe exponer coincidencias de catalogo para auditoria');
}
if (!String(validAi.price_context_json).includes('12990')) {
  fail('AI valida debe exponer contexto de precio para auditoria');
}
if (!String(validAi.commercial_context_counts_json).includes('price_rules')) {
  fail('AI valida debe exponer conteos de contexto comercial para auditoria');
}

// Regla PRD (mencion directa de producto): el cliente responde SOLO el nombre
// del material -> product queda satisfecho por la mencion y se pregunta
// modalidad (nada de preguntar el producto de nuevo).
const productMentionedTurn = await runApplyAi(mergedAiShape({
  ...baseDeterministic,
  text_body: 'Baldosas',
  normalized_text: 'baldosas',
  pending_question_key: 'product',
  response_text: '¿Qué producto de hormigón necesitas para tu proyecto?',
  response_kind: 'advisor_guardrail_question',
}, {
  ai_skipped_1: false,
  intent_1: 'quote_request',
  confidence: 0.9,
  service: 'Baldosas',
  requirement: 'Cotizar baldosas',
  explicitly_mentioned_fields: ['product'],
  catalog_matches: [],
  field_updates: {},
  reply_text: 'Perfecto, ¿en qué modalidad la necesitas?',
}));
if (productMentionedTurn.qualification_context.product !== 'Baldosas') {
  fail('La mencion directa del material debe satisfacer product sin SKU');
}
if (productMentionedTurn.pending_question_key !== 'modality') {
  fail('Con producto satisfecho la siguiente pregunta comercial es la modalidad');
}
if (!String(productMentionedTurn.response_text).includes('solo material')) {
  fail('La pregunta siguiente debe ir a la modalidad, no al producto');
}
if (String(productMentionedTurn.response_text).includes('¿Qué producto de hormigón necesitas')) {
  fail('La pregunta circular del producto no debe reaparecer');
}

// Regla PRD (clasificacion product vs service): "Hormigón Armado Losa" es un
// PRODUCTO aunque el modelo lo clasifique como instalacion; no se activa el
// perfil de instalacion sin evidencia de servicio.
const hormigonMention = await runApplyAi(mergedAiShape({
  ...baseDeterministic,
  text_body: 'Hormigón Armado Losa 100 M2',
  normalized_text: 'hormigon armado losa 100 m2',
}, {
  ai_skipped_1: false,
  intent_1: 'installation_inquiry',
  confidence: 0.9,
  service: 'Hormigon',
  requirement: 'Cotizar una losa de hormigon',
  modality: 'installation',
  explicitly_mentioned_fields: ['product'],
  catalog_matches: [],
  field_updates: {},
  reply_text: 'Para instalación necesitamos revisar medidas y terreno.',
}));
if (hormigonMention.qualification_context.product !== 'Hormigon Armado Losa') {
  fail('La mencion literal "Hormigon Armado Losa" debe completar el producto');
}
if (hormigonMention.pending_question_key !== 'modality') {
  fail('Producto de hormigon sin servicio debe preguntar modalidad primero');
}
const hormigonMissing = JSON.parse(hormigonMention.commercial_missing_fields_json);
if (hormigonMissing.includes('terrain') || hormigonMissing.includes('access') || hormigonMissing.includes('debris_removal')) {
  fail('La modalidad AI sin evidencia no debe activar el perfil de instalacion');
}

// Regla PRD (sin pregunta circular de producto): si el cliente no menciona
// producto, el pending queda en product pero el advisor NO formula la
// pregunta circula vieja; el texto lo pone la IA (o el fallback determinista).
const noProductMention = await runApplyAi(mergedAiShape({
  ...baseDeterministic,
  text_body: 'Si',
  normalized_text: 'si',
  pending_question_key: 'product',
  requirement: 'Seleccionar producto del menú',
  response_text: 'Perfecto. Trabajamos con hormigón, losas, vigas, muros y cierres. ¿Cuál te interesa?',
  response_kind: 'menu_productos',
}, {
  ai_skipped_1: false,
  intent_1: 'quote_request',
  confidence: 0.9,
  service: 'Hormigón',
  requirement: 'Seleccionar producto del menú',
  explicitly_mentioned_fields: [],
  field_updates: {},
  catalog_matches: [],
  reply_text: 'Genial, ¿qué producto necesitas?',
}));
if (noProductMention.pending_question_key !== 'product') {
  fail('Sin mencion de producto el pending debe seguir en product');
}
if (String(noProductMention.response_text).includes('¿Qué producto de hormigón necesitas')) {
  fail('El advisor no debe preguntar el producto con la pregunta circular vieja');
}
if (!String(noProductMention.response_text).includes('¿qué producto necesitas')) {
  fail('La pregunta de producto la formula el modelo con su propia voz');
}

const preservedContext = await runApplyAi(mergedAiShape({
  ...baseDeterministic,
  qualification_context: {
    customer_type: 'b2b',
    lead_class: 'D',
    modality: 'delivery',
    objection_detected: 'price',
    diagnostic_datos: { pain: 'Necesita despacho para una obra' },
  },
}, {
  ai_skipped_1: false,
  intent_1: 'provide_info',
  confidence: 0.9,
  customer_type: 'unknown',
  lead_class: 'none',
  modality: 'unknown',
  objection_detected: 'none',
  diagnostic_datos: {},
  reply_text: '¿Que dato te falta confirmar?',
}));
if (
  preservedContext.qualification_context.customer_type !== 'b2b'
  || preservedContext.qualification_context.lead_class !== 'D'
  || preservedContext.qualification_context.modality !== 'delivery'
  || preservedContext.qualification_context.objection_detected !== 'price'
  || preservedContext.qualification_context.diagnostic_datos?.pain !== 'Necesita despacho para una obra'
) {
  fail('Sentinelas unknown/none o diagnostico vacio no deben borrar contexto comercial valido');
}

const correctedRequest = await runApplyAi(mergedAiShape({
  ...baseDeterministic,
  text_body: 'Quiero un cierro de hormigón no una solerilla',
  normalized_text: 'quiero un cierro de hormigon no una solerilla',
  service: 'Solerilla',
  requirement: 'Necesito precio del metro lineal de solerilla',
  current_step: 'city',
}, {
  ai_skipped_1: false,
  intent_1: 'new_request',
  confidence: 0.85,
  service: 'Cierro de hormigón',
  requirement: 'Cotizar un cierro de hormigón',
  explicitly_mentioned_fields: ['service', 'requirement'],
  reply_text: 'Entiendo, necesitas un cierro de hormigón. ¿En qué comuna está el proyecto?',
  objection_detected: 'none',
  price_context: { type: 'none', requires_validation: true },
}));
if (correctedRequest.service !== 'Cierro de hormigón') {
  fail('Una solicitud explicita debe reemplazar el servicio obsoleto');
}
if (correctedRequest.requirement !== 'Cotizar un cierro de hormigón') {
  fail('Una solicitud explicita debe reemplazar el requerimiento obsoleto');
}
if (!correctedRequest.ai_accepted_fields.includes('service')) {
  fail('La auditoria debe registrar el reemplazo explicito del servicio');
}

const aiVoice = await runApplyAi(mergedAiShape(baseDeterministic, {
  ai_skipped_1: false,
  intent_1: 'provide_info',
  confidence: 0.9,
  reply_text: 'Te ayudo a elegir bien. ¿El proyecto es para un patio, una entrada vehicular o una obra?',
  enhancement_type: 'data_collection',
  objection_detected: 'none',
  price_context: { type: 'none', requires_validation: true },
}));
if (aiVoice.response_text !== 'Te ayudo a elegir bien. ¿El proyecto es para un patio, una entrada vehicular o una obra?') {
  fail('Una respuesta AI sana debe ser la voz principal, aunque no agregue campos nuevos');
}
if (aiVoice.response_kind !== 'ai_data_collection') {
  fail('La respuesta conversacional AI debe conservar su tipo de mejora');
}

const inventedStock = await runApplyAi(mergedAiShape(baseDeterministic, {
  ai_skipped_1: false,
  intent_1: 'stock_inquiry',
  confidence: 0.9,
  reply_text: 'Tenemos stock disponible de baldosas.',
  objection_detected: 'stock',
  price_context: { type: 'none', requires_validation: true },
}));
if (inventedStock.response_kind !== 'prd_validated_fallback') {
  fail('Una confirmacion de stock inventada debe ser bloqueada por guardrails');
}
if (!inventedStock.response_text.includes('disponibilidad debe confirmarla el equipo')) {
  fail('El bloqueo de stock debe responder con el texto seguro del PRD');
}

const inventedPrice = await runApplyAi(mergedAiShape(baseDeterministic, {
  ai_skipped_1: false,
  intent_1: 'price_inquiry',
  confidence: 0.9,
  reply_text: 'El valor es $19.990 por metro cuadrado.',
  objection_detected: 'none',
  price_context: { type: 'none', requires_validation: true },
}));
if (inventedPrice.response_kind !== 'prd_validated_fallback') {
  fail('Un precio sin contexto oficial debe ser bloqueado por guardrails');
}

const confirmedAi = await runApplyAi(mergedAiShape({
  ...baseDeterministic,
  text_body: 'Sí',
  normalized_text: 'si',
  service: 'Baldosas',
  city: 'Santiago',
  requirement: 'Renovar un baño',
  current_step: 'confirm',
  response_kind: 'confirmation_question',
  response_text: '¿Está correcto?',
  completed_fields_count: 3,
  qualification_context: {
    product: 'Baldosas',
    quantity: '20 unidades',
    commune: 'Santiago',
    modality: 'material',
  },
}, {
  ai_skipped_1: false,
  intent_1: 'confirmation_yes',
  service: 'Baldosas',
  city: 'Santiago',
  requirement: 'Renovar un baño',
  confirmation_status: 'confirmed',
  confidence: 0.95,
  should_create_lead: true,
  reply_text: 'Perfecto, derivare tu solicitud.',
}));
if (confirmedAi.should_create_lead !== true) fail('Hormi Atencion debe poder decidir crear lead confirmado');
if (confirmedAi.response_kind !== 'handoff_pending') fail('Lead confirmado debe esperar la creacion real antes de anunciar handoff');
if (confirmedAi.response_text !== '') fail('El orquestador no debe prometer derivacion antes de crear el lead');

const aiConfirmationAttempt = async ({
  textBody,
  normalizedText,
  currentStep = 'confirm',
  pendingQuestionKey = null,
  escalationArea = 'none',
}) => runApplyAi(mergedAiShape({
  ...baseDeterministic,
  text_body: textBody,
  normalized_text: normalizedText,
  service: 'Baldosas',
  city: 'Santiago',
  requirement: 'Renovar un baño',
  current_step: currentStep,
  pending_question_key: pendingQuestionKey,
  response_kind: 'confirmation_question',
  response_text: '¿Está correcto?',
  completed_fields_count: 3,
  qualification_context: {
    product: 'Baldosas', quantity: '20 unidades', commune: 'Santiago', modality: 'material',
  },
}, {
  ai_skipped_1: false,
  intent_1: 'confirmation_yes',
  service: 'Baldosas',
  city: 'Santiago',
  requirement: 'Renovar un baño',
  confirmation_status: 'confirmed',
  confidence: 0.95,
  should_create_lead: true,
  escalation_area: escalationArea,
  reply_text: 'Perfecto, derivare tu solicitud.',
}));

const greetingMisclassifiedAsConfirmation = await aiConfirmationAttempt({
  textBody: 'Hola',
  normalizedText: 'hola',
});
if (greetingMisclassifiedAsConfirmation.should_create_lead !== false) {
  fail('Hola nunca debe crear un lead aunque AI lo clasifique como confirmation_yes');
}

const newQuoteMisclassifiedAsConfirmation = await aiConfirmationAttempt({
  textBody: 'Quiero una nueva cotización',
  normalizedText: 'quiero una nueva cotizacion',
});
if (newQuoteMisclassifiedAsConfirmation.should_create_lead !== false) {
  fail('Una nueva cotizacion nunca debe crear lead por una confirmation_yes incorrecta de AI');
}

const affirmativeNewQuote = await aiConfirmationAttempt({
  textBody: 'Sí, quiero una nueva cotización',
  normalizedText: 'si quiero una nueva cotizacion',
});
if (affirmativeNewQuote.should_create_lead !== false) {
  fail('Una frase afirmativa de nueva solicitud no debe atravesar la whitelist anclada');
}

const confirmationOutsideConfirmStep = await aiConfirmationAttempt({
  textBody: 'Sí',
  normalizedText: 'si',
  currentStep: 'requirement',
});
if (confirmationOutsideConfirmStep.should_create_lead !== false) {
  fail('Una afirmacion explicita fuera del paso confirm no debe crear lead');
}

const confirmationForNonFinalQuestion = await aiConfirmationAttempt({
  textBody: 'Sí',
  normalizedText: 'si',
  pendingQuestionKey: 'installation_required',
});
if (confirmationForNonFinalQuestion.should_create_lead !== false) {
  fail('Una afirmacion a una pregunta no final no debe crear lead');
}

for (const [textBody, normalizedText] of [
  ['Sí, por favor', 'si por favor'],
  ['Sí, correcto', 'si correcto'],
  ['De acuerdo', 'de acuerdo'],
]) {
  const commonConfirmation = await aiConfirmationAttempt({ textBody, normalizedText });
  if (commonConfirmation.should_create_lead !== true) {
    fail(`${textBody} debe aceptarse como confirmacion final explicita`);
  }
}

const salesHandoffWinsOverAiEscalation = await runApplyAi(mergedAiShape({
  ...baseDeterministic,
  text_body: 'Sí',
  normalized_text: 'si',
  service: 'Baldosas',
  city: 'Santiago',
  requirement: 'Renovar un baño',
  current_step: 'confirm',
  response_kind: 'confirmation_question',
  completed_fields_count: 3,
  qualification_context: {
    product: 'Baldosas', quantity: '20 unidades', commune: 'Santiago', modality: 'material',
  },
}, {
  ai_skipped_1: false,
  intent_1: 'confirmation_yes',
  service: 'Baldosas',
  city: 'Santiago',
  requirement: 'Renovar un baño',
  confirmation_status: 'confirmed',
  confidence: 0.95,
  should_create_lead: true,
  escalation_area: 'sales',
}));
if (salesHandoffWinsOverAiEscalation.conversation_status_code !== 'handed_to_sales') {
  fail('Un lead confirmado debe quedar handed_to_sales aunque AI entregue escalation_area=sales');
}
if (salesHandoffWinsOverAiEscalation.should_escalate !== false) {
  fail('escalation_area=sales no debe activar should_escalate en un handoff comercial');
}
if (salesHandoffWinsOverAiEscalation.escalation_reason !== null) {
  fail('escalation_area=sales no debe producir escalation_reason operativa');
}
const salesHandoffMetadata = JSON.parse(salesHandoffWinsOverAiEscalation.metadata_json);
if (salesHandoffMetadata.ai_escalation_requested !== false) {
  fail('escalation_area=sales no debe marcar ai_escalation_requested');
}

const genuineEscalation = await runApplyAi(mergedAiShape({
  ...baseDeterministic,
  should_escalate: true,
  escalation_reason: 'frustration_detected',
}, {
  ai_skipped_1: false,
  confidence: 0.9,
  should_create_lead: false,
  escalation_area: 'sales',
}));
if (genuineEscalation.conversation_status_code !== 'escalation_required') {
  fail('Una escalacion genuina debe persistir escalation_required');
}
if (genuineEscalation.should_escalate !== true || genuineEscalation.escalation_reason !== 'frustration_detected') {
  fail('La escalacion deterministica genuina debe conservar flag y razon aunque AI indique sales');
}
if (JSON.parse(genuineEscalation.metadata_json).ai_escalation_requested !== true) {
  fail('Una escalacion deterministica genuina debe quedar auditada');
}

const rejectedConfirmationAi = {
  ai_skipped_1: false,
  intent_1: 'confirmation_no',
  confirmation_status: 'rejected',
  confidence: 0.95,
  should_create_lead: false,
  reply_text: 'Tengo registrado Placas en Vitacura para Cierre perimetral. ¿Confirmas que estos datos están correctos?',
  escalation_area: 'none',
};
const rejectionStateInput = (previous, textBody = 'no') => ({
  phone_number: 'test-contact-regression-017',
  message_type: 'text',
  text_body: textBody,
  raw_payload_json: '{}',
  has_active_conversation: true,
  conversation_status_code: previous.conversation_status_code || 'waiting_user',
  current_step: previous.current_step,
  state_current_step: previous.current_step,
  state_service: previous.service,
  state_city: previous.city,
  state_requirement: previous.requirement,
  qualification_context: previous.qualification_context || {},
  pending_question_key: previous.pending_question_key,
});
const runRejectedConfirmationTurn = async (previous) => {
  const evaluated = await runEvaluate(rejectionStateInput(previous));
  return runApplyAi(mergedAiShape(evaluated, rejectedConfirmationAi));
};
const finalSummaryState = {
  service: 'Placas',
  city: 'Vitacura',
  requirement: 'Cierre perimetral',
  qualification_context: {
    product: 'Placas', quantity: '40 unidades', commune: 'Vitacura', modality: 'material',
  },
  current_step: 'confirm|%7B%22service%22%3A%22Placas%22%2C%22city%22%3A%22Vitacura%22%2C%22requirement%22%3A%22Cierre%20perimetral%22%7D',
  conversation_status_code: 'waiting_user',
  pending_question_key: 'final_confirmation',
};

const legacyDriftedSummaryState = {
  ...finalSummaryState,
  current_step: 'previous_context|%7B%22service%22%3A%22Placas%22%2C%22city%22%3A%22Vitacura%22%2C%22requirement%22%3A%22Cierre%20perimetral%22%7D',
};
const repairedLegacyRejection = await runRejectedConfirmationTurn(legacyDriftedSummaryState);
if (
  repairedLegacyRejection.response_text !== 'Entiendo. ¿Qué dato de la solicitud quieres corregir?'
  || !String(repairedLegacyRejection.current_step).startsWith('confirm_retry_1|')
  || repairedLegacyRejection.pending_question_key !== 'confirmation_correction'
) {
  fail('pending final_confirmation debe reparar previous_context legado al recibir no');
}

const firstRejectedConfirmation = await runRejectedConfirmationTurn(finalSummaryState);
if (firstRejectedConfirmation.response_text !== 'Entiendo. ¿Qué dato de la solicitud quieres corregir?') {
  fail('Resumen -> no debe preguntar que dato corregir sin repetir la confirmacion final');
}
if (
  !String(firstRejectedConfirmation.current_step).startsWith('confirm_retry_1|')
  || firstRejectedConfirmation.pending_question_key !== 'confirmation_correction'
) {
  fail('Pregunta visible, current_step y pending_question_key deben quedar sincronizados tras rechazo');
}
if (firstRejectedConfirmation.should_create_lead !== false) {
  fail('Un rechazo de confirmacion final nunca debe crear lead');
}

const explicitCorrectionEvaluation = await runEvaluate(rejectionStateInput(
  firstRejectedConfirmation,
  'Corrijo, la ciudad es Valparaíso'
));
const explicitCorrectionApplied = await runApplyAi(mergedAiShape(explicitCorrectionEvaluation, {
  ai_skipped_1: false,
  intent_1: 'correction',
  confirmation_status: 'none',
  confidence: 0.95,
  should_create_lead: false,
  service: 'Placas',
  city: 'Valparaíso',
  requirement: 'Cierre perimetral',
  explicitly_mentioned_fields: ['city'],
  reply_text: 'Perfecto, actualicé la ciudad a Valparaíso. ¿Confirmas que los datos están correctos?',
  escalation_area: 'none',
}));
if (explicitCorrectionApplied.city !== 'Valparaíso') {
  fail('La correccion explicita posterior al rechazo debe actualizar el campo');
}
if (
  !String(explicitCorrectionApplied.current_step).startsWith('confirm|')
  || explicitCorrectionApplied.pending_question_key !== 'final_confirmation'
) {
  fail('Despues de corregir debe volver a confirmacion final sincronizada');
}
if (explicitCorrectionApplied.should_create_lead !== false) {
  fail('Corregir un campo no crea lead hasta una nueva confirmacion final');
}

const secondRejectedConfirmation = await runRejectedConfirmationTurn(firstRejectedConfirmation);
if (!String(secondRejectedConfirmation.current_step).startsWith('confirm_retry_2|')) {
  fail('El segundo rechazo sin resolver debe incrementar el contador');
}
const thirdRejectedConfirmation = await runRejectedConfirmationTurn(secondRejectedConfirmation);
if (thirdRejectedConfirmation.conversation_status_code !== 'escalation_required') {
  fail('Tres rechazos sin resolver deben escalar a humano');
}
if (
  thirdRejectedConfirmation.should_escalate !== true
  || thirdRejectedConfirmation.escalation_reason !== 'confirmation_rejection_loop'
  || thirdRejectedConfirmation.pending_question_key !== null
) {
  fail('La escalacion por rechazos debe persistir flag, razon y limpiar la pregunta pendiente');
}
if (
  thirdRejectedConfirmation.response_kind !== 'escalation_routing'
  || !thirdRejectedConfirmation.response_text.includes('persona del equipo')
) {
  fail('El tercer rechazo debe informar derivacion humana, no repetir la pregunta');
}
const postEscalationInput = rejectionStateInput(
  thirdRejectedConfirmation,
  'Hola, sigo esperando'
);
const postEscalationEvaluation = await runEvaluate(postEscalationInput);
const postEscalationApplied = await runApplyAi(mergedAiShape(postEscalationEvaluation, {
  ai_skipped_1: false,
  intent_1: 'provide_info',
  confidence: 0.95,
  should_create_lead: false,
  reply_text: '¿Qué producto necesitas cotizar?',
  escalation_area: 'none',
}));
if (
  postEscalationApplied.conversation_status_code !== 'escalation_required'
  || postEscalationApplied.response_kind !== 'escalation_already_required'
  || !postEscalationApplied.response_text.includes('persona del equipo')
) {
  fail('Una conversacion ya escalada debe informar su derivacion sin reactivar preguntas automaticas');
}

const lowConfidence = await runApplyAi(mergedAiShape(baseDeterministic, {
  ai_skipped_1: false,
  intent_1: 'quote_request',
  service: 'Baldosas',
  requirement: 'Renovar un baño',
  confidence: 0.5,
}));
if (lowConfidence.ai_applied !== false) fail('AI baja confianza no debe aplicar campos');
if (lowConfidence.service !== null || lowConfidence.requirement !== null) fail('AI baja confianza cambio campos');

const correction = await runApplyAi(mergedAiShape({
  ...baseDeterministic,
  service: 'Ceramicas',
  text_body: 'Corrijo, necesito baldosas',
  normalized_text: 'corrijo necesito baldosas',
  response_kind: 'question',
}, {
  ai_skipped_1: false,
  intent_1: 'correction',
  service: 'Baldosas',
  city: 'Santiago',
  confidence: 0.9,
}));
if (correction.service !== 'Baldosas') fail('Correccion explicita debe permitir sobrescribir campo');
if (correction.should_create_lead !== false) fail('Correccion AI no puede crear lead sin confirmacion');


// P0: provider/config errors must preserve the deterministic visible reply end-to-end.
const deterministicGreeting = await runEvaluate({
  phone_number: 'test-contact-regression-020', message_type: 'text', text_body: 'Hola', raw_payload_json: '{}',
  has_active_conversation: false, conversation_status_code: null,
});
const integratedFallback = await runApplyAi(mergedAiShape(deterministicGreeting, {
  ai_skipped_1: false,
  ai_request_error_1: 'provider_error',
  ai_fallback_reason_1: 'provider_error',
  confidence: 0,
}));
if (!integratedFallback.response_text || integratedFallback.response_text !== deterministicGreeting.deterministic_reply) {
  fail('Evaluate -> Apply debe conservar deterministic_reply cuando la IA falla');
}

// P0: a terminal handoff starts a clean request in a new conversation row.
const postHandoffFresh = await runEvaluate({
  phone_number: 'test-contact-regression-021', message_type: 'text', text_body: 'Hola', raw_payload_json: '{}',
  has_active_conversation: true, conversation_status_code: 'handed_to_sales', conversation_id: 84, lead_id: 30,
  current_step: 'complete|%7B%22service%22%3A%22Placas%22%2C%22city%22%3A%22Vitacura%22%2C%22requirement%22%3A%22Cierre%22%7D',
  state_current_step: 'complete|%7B%22service%22%3A%22Placas%22%2C%22city%22%3A%22Vitacura%22%2C%22requirement%22%3A%22Cierre%22%7D',
  state_service: 'Placas', state_city: 'Vitacura', state_requirement: 'Cierre', previous_lead_id: 30,
  previous_service: 'Placas', previous_city: 'Vitacura', previous_requirement: 'Cierre',
});
if (postHandoffFresh.conversation_id !== null || postHandoffFresh.lead_id !== null || postHandoffFresh.reset_conversation_lead !== true) {
  fail('Recontacto post-handoff debe crear otra conversacion y desvincular el lead anterior');
}
if (/^previous_context|^confirm/.test(postHandoffFresh.current_step) || postHandoffFresh.service || postHandoffFresh.city || postHandoffFresh.requirement) {
  fail('Recontacto post-handoff no debe regenerar previous_context/final_confirmation ni campos antiguos');
}

// P0: after 30d the turn starts a new request and cuts implicit context.
const timedOutFresh = await runEvaluate({
  phone_number: 'test-contact-regression-024', message_type: 'text', text_body: 'Hola', raw_payload_json: '{}',
  has_active_conversation: false, has_existing_conversation: true, is_stale_context: true,
  is_reengagement: false, elapsed_hours_since_last_inbound: 31 * 24,
  conversation_status_code: 'waiting_user', conversation_id: 92, lead_id: 32,
  current_step: 'confirm', state_current_step: 'confirm', state_service: 'Bloques', state_city: 'Colina',
  state_requirement: 'Muro', previous_lead_id: 32, previous_service: 'Bloques', previous_city: 'Colina',
  previous_requirement: 'Muro', qualification_context: { measurements: '40 m2' },
  recent_messages: [{ role: 'assistant', content: 'Resumen antiguo' }],
});
if (timedOutFresh.conversation_id !== null || !timedOutFresh.reset_conversation_lead) {
  fail('Contexto mayor a 30 dias debe iniciar una conversacion nueva');
}
if (timedOutFresh.service || timedOutFresh.city || timedOutFresh.requirement || timedOutFresh.recent_messages.length) {
  fail('Contexto mayor a 30 dias debe cortar campos e historial implicitos');
}
const timedOutApplied = await runApplyAi(mergedAiShape(timedOutFresh, {
  ai_skipped_1: false, intent_1: 'greeting', confidence: 0.95,
  service: 'Bloques', city: 'Colina', requirement: 'Muro', field_updates: { measurements: '40 m2' },
  reply_text: 'Hola, ¿en que ciudad necesitas cotizar?',
}));
if (timedOutApplied.service || timedOutApplied.city || timedOutApplied.requirement || Object.keys(timedOutApplied.qualification_context).length) {
  fail('Contexto mayor a 30 dias no debe reinyectar campos ni qualification_context mediante AI');
}

// P0: an escalated conversation can explicitly start a clean request instead of becoming a blackhole.
const reopenedEscalation = await runEvaluate({
  phone_number: 'test-contact-regression-022', message_type: 'text', text_body: 'Nueva cotización', raw_payload_json: '{}',
  has_active_conversation: false, conversation_status_code: 'escalation_required', conversation_id: 90, lead_id: 31,
  current_step: 'escalation', state_current_step: 'escalation', previous_lead_id: 31,
  previous_service: 'Bloques', previous_city: 'Colina', previous_requirement: 'Muro',
});
if (reopenedEscalation.conversation_id !== null || reopenedEscalation.conversation_status_code !== 'waiting_user' || reopenedEscalation.should_escalate) {
  fail('Nueva cotizacion debe salir de escalation_required en una conversacion nueva');
}
if (!reopenedEscalation.deterministic_reply || reopenedEscalation.pending_question_key !== null) {
  fail('Reapertura de escalacion debe responder y mantener pregunta/estado coherentes');
}

// P0: explicit human request wins over confirmation and never creates a lead.
const humanAtConfirmation = await runEvaluate({
  phone_number: 'test-contact-regression-023', message_type: 'text', text_body: 'Quiero hablar con una ejecutiva', raw_payload_json: '{}',
  has_active_conversation: true, conversation_status_code: 'waiting_user', conversation_id: 91,
  current_step: 'confirm|%7B%22service%22%3A%22Placas%22%2C%22city%22%3A%22Vitacura%22%2C%22requirement%22%3A%22Cierre%22%7D',
  state_current_step: 'confirm|%7B%22service%22%3A%22Placas%22%2C%22city%22%3A%22Vitacura%22%2C%22requirement%22%3A%22Cierre%22%7D',
  state_service: 'Placas', state_city: 'Vitacura', state_requirement: 'Cierre', pending_question_key: 'final_confirmation',
});
if (!humanAtConfirmation.should_escalate || humanAtConfirmation.should_create_lead || humanAtConfirmation.pending_question_key !== null) {
  fail('Pedido humano debe escalar sin crear lead ni conservar confirmacion pendiente');
}
const humanApplied = await runApplyAi(mergedAiShape(humanAtConfirmation, {
  ai_skipped_1: false, intent_1: 'confirmation_yes', confirmation_status: 'confirmed', confidence: 0.99,
  should_create_lead: true, escalation_area: 'sales', reply_text: 'Confirma los datos.',
}));
if (!humanApplied.should_escalate || humanApplied.should_create_lead || /confirm/i.test(humanApplied.response_text)) {
  fail('Apply debe mantener lead/escalacion/pregunta mutuamente excluyentes');
}

// P0: stale secondary updates require the pending question or direct textual evidence.
const staleSecondary = await runApplyAi(mergedAiShape(baseDeterministic, {
  ai_skipped_1: false, intent_1: 'provide_info', confidence: 0.95,
  field_updates: { measurements: '40 m2', company: 'Empresa antigua' },
  reply_text: '¿Que necesitas?',
}));
if (staleSecondary.qualification_context.measurements || staleSecondary.qualification_context.company) {
  fail('field_updates secundarios sin evidencia actual no deben contaminar la solicitud');
}
const pendingMeasurement = await runApplyAi(mergedAiShape({
  ...baseDeterministic, text_body: '40 m2', normalized_text: '40 m2', pending_question_key: 'measurements',
}, {
  ai_skipped_1: false, intent_1: 'provide_info', confidence: 0.95,
  field_updates: { measurements: '40 m2' }, reply_text: 'Gracias.',
}));
if (pendingMeasurement.qualification_context.measurements !== '40 m2') {
  fail('field_updates debe aceptar la respuesta a la pregunta pendiente');
}

const contextualNo = await runEvaluate({
  phone_number: 'test-contact-regression-016',
  message_type: 'text',
  text_body: 'no',
  raw_payload_json: '{}',
  has_active_conversation: true,
  conversation_status_code: 'waiting_user',
  current_step: 'confirm|%7B%22service%22%3A%22Placas%22%2C%22city%22%3A%22Vitacura%22%2C%22requirement%22%3A%22Cierre%20perimetral%22%7D',
  state_current_step: 'confirm|%7B%22service%22%3A%22Placas%22%2C%22city%22%3A%22Vitacura%22%2C%22requirement%22%3A%22Cierre%20perimetral%22%7D',
  state_service: 'Placas',
  state_city: 'Vitacura',
  state_requirement: 'Cierre perimetral',
  qualification_context: { product: 'Placas', commune: 'Vitacura', modality: 'installation', measurements: '150 metros', terrain: 'plano', truck_access: true },
  pending_question_key: 'debris_removal',
});
if (contextualNo.reset_conversation_lead === true) {
  fail('Un no a retiro de escombros no debe reiniciar la solicitud');
}
if (contextualNo.service !== 'Placas' || contextualNo.city !== 'Vitacura') {
  fail('Un no contextual debe conservar producto y comuna');
}
// PRD 13.4 (B06): product y commune llevan evidencia del cliente (mensajes
// previos del flujo), asi el turno responde la pregunta de escombros y vuelve
// a la confirmacion final sin re-abrir campos ya garantizados por evidencia.

const contextualAi = await runApplyAi(mergedAiShape(contextualNo, {
  ai_skipped_1: false,
  intent: 'provide_info',
  confidence: 0.96,
  service: 'Placas',
  city: 'Vitacura',
  requirement: 'Cierre perimetral',
  confirmation_status: 'none',
  should_create_lead: false,
  field_updates: { debris_removal: false },
  answered_question_key: 'debris_removal',
  next_question_key: 'final_confirmation',
  reply_text: 'Perfecto, entonces consideramos la instalación sin retiro de escombros. ¿Confirmas que estos datos están correctos para derivar la cotización?',
  diagnostic_datos: {
    pain: 'Delimitar y dar seguridad al terreno',
    scope: 'Cierre de placas de 150 metros en terreno plano',
    timing: '',
    obstacle: '',
    next_step: 'Confirmar datos',
  },
  objection_detected: 'none',
  price_context: { type: 'none', requires_validation: true },
}));
if (contextualAi.qualification_context.debris_removal !== false) {
  fail('La respuesta no debe persistirse como debris_removal=false');
}
if (contextualAi.pending_question_key !== 'final_confirmation') {
  fail('Luego del dato de escombros debe quedar una confirmacion final contextual');
}
if (contextualAi.service !== 'Placas' || contextualAi.city !== 'Vitacura') {
  fail('La asistencia AI contextual no debe perder el nucleo de la oportunidad');
}

console.log(`Conversation regression local smoke OK: ${suite.cases.length} casos validados`);
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
NODE
