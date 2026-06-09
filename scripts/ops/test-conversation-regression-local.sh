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
const suite = JSON.parse(fs.readFileSync(samplePath, 'utf8'));
const matrix = fs.readFileSync(matrixPath, 'utf8');
const orchestrator = JSON.parse(fs.readFileSync(orchestratorPath, 'utf8'));

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

const aiLinkNode = orchestrator.nodes.find((node) => node.name === 'Execute AI Lead Qualification');
if (!aiLinkNode || aiLinkNode.type !== 'n8n-nodes-base.executeWorkflow') {
  fail('Falta nodo Execute AI Lead Qualification como executeWorkflow');
}

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const runApplyAi = async (row, env = { AI_LEAD_ASSISTANT_ENABLED: 'true' }) => {
  const fn = new AsyncFunction('items', '$env', applyNode.parameters.jsCode);
  const result = await fn([{ json: row }], env);
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

const disabled = await runApplyAi(
  mergedAiShape(baseDeterministic, {
    ai_skipped_1: true,
    ai_skip_reason_1: 'disabled',
    service: 'Baldosas',
    requirement: 'Renovar un baño',
    confidence: 0.92,
  }),
  { AI_LEAD_ASSISTANT_ENABLED: 'false' }
);
if (disabled.ai_applied !== false) fail('AI apagada no debe aplicar campos');
if (disabled.service !== null || disabled.requirement !== null) fail('AI apagada cambio campos determinísticos');

const validAi = await runApplyAi(mergedAiShape(baseDeterministic, {
  ai_skipped_1: false,
  intent_1: 'quote_request',
  service: 'Baldosas',
  city: 'Santiago',
  requirement: 'Renovar un baño',
  confirmation_status: 'requested',
  confidence: 0.92,
  should_create_lead: true,
}));
if (validAi.ai_applied !== true) fail('AI valida debio asistir extraccion');
if (validAi.service !== 'Baldosas' || validAi.requirement !== 'Renovar un baño') fail('AI valida no mezclo campos esperados');
if (validAi.should_create_lead !== false) fail('Hormi Atencion no puede crear lead sin confirmacion');
if (!String(validAi.current_step).startsWith('confirm|')) fail('AI valida con campos completos debe pedir confirmacion');

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
