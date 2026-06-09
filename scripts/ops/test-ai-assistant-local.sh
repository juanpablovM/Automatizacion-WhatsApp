#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
cd "$ROOT_DIR"

node <<'NODE'
(async () => {
  const fs = require('fs');
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const workflow = JSON.parse(fs.readFileSync('n8n/workflows/ai-lead-qualification-assistant.json', 'utf8'));

  const nodeCode = (name) => {
    const node = workflow.nodes.find((entry) => entry.name === name);
    if (!node) throw new Error(`No existe nodo ${name}`);
    return node.parameters.jsCode;
  };

  const runCode = async (name, item, helpers = {}, env = {}) => {
    const fn = new AsyncFunction('items', 'helpers', '$env', nodeCode(name));
    const result = await fn([{ json: item }], helpers, env);
    return result[0].json;
  };

  const readSample = (name) => JSON.parse(fs.readFileSync(`n8n/samples/${name}`, 'utf8'));
  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const expectEqual = (actual, expected, message) => {
    assert(actual === expected, `${message}: esperado ${JSON.stringify(expected)}, recibido ${JSON.stringify(actual)}`);
  };
  const expectIncludes = (actual, expected, message) => {
    assert(Array.isArray(actual) && actual.includes(expected), `${message}: ${expected} no esta en ${JSON.stringify(actual)}`);
  };

  const env = {
    AI_LEAD_ASSISTANT_ENABLED: 'true',
    AI_PROVIDER: 'openclaw',
    AI_API_KEY_REQUIRED: 'false',
    OPENCLAW_BRIDGE_URL: 'http://host.docker.internal:9090',
    OPENCLAW_BRIDGE_TOKEN: 'test-bridge-token',
    OPENCLAW_AGENT: 'hormi-atencion',
    EXTERNAL_HTTP_MAX_ATTEMPTS: '2',
    EXTERNAL_HTTP_RETRY_BASE_MS: '1',
    EXTERNAL_HTTP_RETRY_MAX_MS: '1',
  };

  const baseResponse = {
    intent: 'unknown',
    lead_quality: 'none',
    service: '',
    city: '',
    requirement: '',
    missing_fields: ['service', 'city', 'requirement', 'confirmation'],
    confirmation_status: 'none',
    should_create_lead: false,
    needs_confirmation: true,
    confidence: 0.8,
    reply_text: '',
    clickup_summary: '',
  };

  const makeBridgeBody = (payload) => ({
    ok: true,
    reply: typeof payload === 'string' ? payload : JSON.stringify(payload),
  });

  const validateRequestContract = async () => {
    const request = await runCode('Build AI Request', readSample('ai_lead_qualification.sample.json'), {}, env);
    const schema = request.response_schema;
    assert(schema, 'No se expone JSON Schema para Hormi Atencion');
    expectEqual(request.ai_provider, 'openclaw', 'Proveedor OpenClaw');
    expectEqual(request.ai_api_mode, 'openclaw', 'Modo OpenClaw');
    expectEqual(request.ai_request_path, '/api/evaluate', 'Endpoint OpenClaw');
    expectEqual(request.ai_base_url, 'http://host.docker.internal:9090', 'Base URL OpenClaw');
    expectEqual(request.ai_request.agent, 'hormi-atencion', 'Agente Hormi Atencion');
    assert(request.ai_request.session_key.startsWith('agent:hormi-atencion:crm-whatsapp-'), 'Session key aislada');
    assert(request.ai_request.context.includes('Tienes autonomia conversacional'), 'Prompt no declara autonomia');
    expectIncludes(schema.required, 'confirmation_status', 'Contrato debe exigir confirmation_status');
    expectEqual(schema.additionalProperties, false, 'Contrato debe rechazar propiedades extra');
  };

  const runMockedScenario = async (scenario) => {
    const input = readSample(scenario.sample);
    const request = await runCode('Build AI Request', input, {}, env);
    let calls = 0;
    const helpers = {
      httpRequest: async (options) => {
        calls += 1;
        expectEqual(options.url, 'http://host.docker.internal:9090/api/evaluate', `${scenario.name} URL`);
        expectEqual(Boolean(options.headers.Authorization), false, `${scenario.name} no usa Authorization`);
        expectEqual(options.headers['X-OpenClaw-Bridge-Token'], 'test-bridge-token', `${scenario.name} bridge token`);
        return {
          statusCode: scenario.statusCode || 200,
          body: scenario.body,
          headers: {},
        };
      },
    };

    const called = await runCode('Call AI Provider', request, helpers, env);
    expectEqual(calls, 1, `${scenario.name} llamadas HTTP`);
    const normalized = await runCode('Normalize AI Result', called, {}, env);
    scenario.expect(normalized);
  };

  await validateRequestContract();

  await runMockedScenario({
    name: 'saludo',
    sample: 'ai_greeting.sample.json',
    body: makeBridgeBody({
      ...baseResponse,
      intent: 'greeting',
      lead_quality: 'none',
      confidence: 0.91,
      reply_text: 'Hola, gracias por escribirnos. ¿Desde que ciudad nos escribes?',
    }),
    expect: (result) => {
      expectEqual(result.intent, 'greeting', 'saludo intent');
      expectIncludes(result.missing_fields, 'service', 'saludo missing service');
      expectEqual(result.should_create_lead, false, 'saludo no crea lead');
    },
  });

  await runMockedScenario({
    name: 'completo sin confirmacion',
    sample: 'ai_complete_without_confirmation.sample.json',
    body: makeBridgeBody({
      ...baseResponse,
      intent: 'quote_request',
      lead_quality: 'high',
      service: 'Baldosas',
      city: 'Santiago',
      requirement: 'Renovar un baño',
      missing_fields: ['confirmation'],
      confirmation_status: 'requested',
      should_create_lead: true,
      confidence: 0.93,
      reply_text: 'Tengo los datos. ¿Esta correcto?',
      clickup_summary: 'No deberia pasar a ClickUp sin confirmacion.',
    }),
    expect: (result) => {
      expectEqual(result.service, 'Baldosas', 'sin confirmacion service');
      expectIncludes(result.missing_fields, 'confirmation', 'sin confirmacion missing confirmation');
      expectEqual(result.model_should_create_lead_raw, true, 'modelo pidio crear lead');
      expectEqual(result.should_create_lead, false, 'guardrail sin confirmacion');
      expectEqual(result.clickup_summary, '', 'sin confirmacion no expone resumen ClickUp');
    },
  });

  await runMockedScenario({
    name: 'completo con confirmacion',
    sample: 'ai_complete_with_confirmation.sample.json',
    body: makeBridgeBody({
      ...baseResponse,
      intent: 'confirmation_yes',
      lead_quality: 'high',
      service: 'Baldosas',
      city: 'Santiago',
      requirement: 'Renovar un baño',
      missing_fields: [],
      confirmation_status: 'confirmed',
      should_create_lead: true,
      needs_confirmation: false,
      confidence: 0.96,
      reply_text: 'Perfecto, derivare tu solicitud.',
      clickup_summary: 'Cliente confirmado solicita baldosas en Santiago para renovar un baño.',
    }),
    expect: (result) => {
      expectEqual(result.intent, 'confirmation_yes', 'confirmacion intent');
      expectEqual(result.confirmation_status, 'confirmed', 'confirmacion status');
      expectEqual(result.should_create_lead, true, 'Hormi Atencion decide crear lead confirmado');
      expectEqual(result.clickup_summary.includes('Cliente confirmado'), true, 'resumen ClickUp');
    },
  });

  await runMockedScenario({
    name: 'correccion',
    sample: 'ai_correction.sample.json',
    body: makeBridgeBody({
      ...baseResponse,
      intent: 'correction',
      lead_quality: 'high',
      service: 'Baldosas',
      city: 'Valparaiso',
      requirement: 'Renovar un baño',
      missing_fields: ['confirmation'],
      confirmation_status: 'requested',
      should_create_lead: false,
      confidence: 0.9,
      reply_text: 'Corregi la ciudad a Valparaiso. ¿Esta correcto?',
    }),
    expect: (result) => {
      expectEqual(result.intent, 'correction', 'correccion intent');
      expectEqual(result.city, 'Valparaiso', 'correccion ciudad');
      expectIncludes(result.missing_fields, 'confirmation', 'correccion requiere confirmacion');
      expectEqual(result.should_create_lead, false, 'correccion no crea lead');
    },
  });

  await runMockedScenario({
    name: 'ambiguo baja confianza',
    sample: 'ai_ambiguous.sample.json',
    body: makeBridgeBody({
      ...baseResponse,
      intent: 'quote_request',
      lead_quality: 'low',
      service: 'Remodelacion',
      city: 'Santiago',
      requirement: 'Algo para la casa',
      missing_fields: ['service', 'requirement', 'confirmation'],
      confirmation_status: 'none',
      should_create_lead: false,
      confidence: 0.61,
      reply_text: '¿Que producto o servicio necesitas?',
    }),
    expect: (result) => {
      expectEqual(result.ai_fallback_reason, 'low_confidence', 'ambiguo fallback');
      expectEqual(result.service, '', 'baja confianza no acepta service');
      expectEqual(result.city, 'Santiago', 'baja confianza conserva city existente');
      expectEqual(result.requirement, '', 'baja confianza no acepta requirement');
      expectEqual(result.reply_text, '', 'baja confianza no expone reply_text');
    },
  });

  await runMockedScenario({
    name: 'respuesta invalida',
    sample: 'ai_complete_without_confirmation.sample.json',
    body: makeBridgeBody('esto no es json'),
    expect: (result) => {
      expectEqual(result.ai_fallback_reason, 'invalid_json', 'invalido fallback seguro');
      expectEqual(Boolean(result.ai_parse_error), true, 'invalido registra parse error');
      expectEqual(result.should_create_lead, false, 'invalido no crea lead');
    },
  });

  const skippedRequest = await runCode('Build AI Request', readSample('ai_greeting.sample.json'), {}, { AI_LEAD_ASSISTANT_ENABLED: 'false' });
  const skippedCall = await runCode('Call AI Provider', skippedRequest, {}, {});
  const skipped = await runCode('Normalize AI Result', skippedCall, {}, {});
  assert(skipped.ai_skipped && skipped.ai_skip_reason === 'disabled', 'Modo disabled no funciona');
  expectEqual(skipped.should_create_lead, false, 'disabled no crea lead');

  console.log('AI assistant local contract OK: 7 escenarios OpenClaw mock sin llamar proveedor real');
})();
NODE
