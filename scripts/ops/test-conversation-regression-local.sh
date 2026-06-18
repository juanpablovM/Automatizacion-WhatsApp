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
const suite = JSON.parse(fs.readFileSync(samplePath, 'utf8'));
const matrix = fs.readFileSync(matrixPath, 'utf8');
const orchestrator = JSON.parse(fs.readFileSync(orchestratorPath, 'utf8'));
const assistant = JSON.parse(fs.readFileSync(assistantPath, 'utf8'));

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

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const runApplyAi = async (row, env = {}) => {
  const fn = new AsyncFunction('items', '$env', applyNode.parameters.jsCode);
  const result = await fn([{ json: row }], env);
  return result[0].json;
};
const runEvaluate = async (row) => {
  const fn = new AsyncFunction('items', evaluateNode.parameters.jsCode);
  const result = await fn([{ json: row }]);
  return result[0].json;
};
const mergedAiShape = (deterministicRow, aiRow) => ({
  ...aiRow,
  ...Object.fromEntries(Object.entries(deterministicRow).map(([key, value]) => [`${key}_1`, value])),
});

const baseDeterministic = {
  phone_number: '+56911111111',
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
  phone_number: '+56911111112',
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
if (!String(communeAndProduct.current_step).startsWith('confirm|')) {
  fail('Mensaje completo con comuna y producto debe pasar a confirmacion');
}

const adoquinRequest = await runEvaluate({
  phone_number: '+56911111115',
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
  phone_number: '+56911111115',
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
  phone_number: '+56911111113',
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
  phone_number: '+56911111114',
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
if (!String(validAi.commercial_missing_fields_json).includes('measurements')) {
  fail('AI valida debe exponer datos comerciales faltantes');
}
if (validAi.escalation_area !== 'sales' || !String(validAi.executive_summary).includes('Cliente B2C')) {
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
  service: 'Baldosas',
  city: 'Santiago',
  requirement: 'Renovar un baño',
  current_step: 'confirm',
  response_kind: 'confirmation_question',
  response_text: '¿Está correcto?',
  completed_fields_count: 3,
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
if (confirmedAi.response_kind !== 'handoff_ready') fail('Lead confirmado por Hormi Atencion debe quedar listo para handoff');

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

console.log(`Conversation regression local smoke OK: ${suite.cases.length} casos validados`);
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
NODE
