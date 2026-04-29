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
    AI_PROVIDER: 'nvidia',
    AI_BASE_URL: 'https://integrate.api.nvidia.com/v1',
    AI_API_MODE: 'chat_completions',
    AI_API_KEY: 'test-key',
    AI_MODEL: 'minimaxai/minimax-m2.5',
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

  const makeChatBody = (payload, contentMode = 'string') => ({
    choices: [
      {
        message: {
          content: contentMode === 'array'
            ? [{ type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload) }]
            : typeof payload === 'string'
              ? payload
              : JSON.stringify(payload),
        },
      },
    ],
  });

  const validateRequestContract = async () => {
    const request = await runCode('Build AI Request', readSample('ai_lead_qualification.sample.json'), {}, env);
    const schema = request.ai_request?.response_format?.json_schema?.schema;
    assert(schema, 'No se construyo JSON Schema para chat_completions');
    expectEqual(request.ai_request.response_format.json_schema.strict, true, 'Structured Outputs strict');
    expectEqual(request.ai_request_path, '/chat/completions', 'Endpoint chat_completions');
    expectEqual(request.ai_request.model, 'minimaxai/minimax-m2.5', 'Modelo NVIDIA MiniMax');
    expectIncludes(schema.required, 'confirmation_status', 'Contrato debe exigir confirmation_status');
    expectEqual(schema.additionalProperties, false, 'Contrato debe rechazar propiedades extra');
    assert(request.ai_request.messages[0].content.includes('confidence es menor a 0.75'), 'Prompt no contiene guardrail de baja confianza');
    assert(request.ai_request.messages[0].content.includes('confirmacion explicita'), 'Prompt no contiene guardrail de confirmacion');

    const responsesRequest = await runCode('Build AI Request', readSample('ai_lead_qualification.sample.json'), {}, { ...env, AI_API_MODE: 'responses' });
    assert(responsesRequest.ai_request?.text?.format?.schema, 'No se construyo JSON Schema para responses');
    expectEqual(responsesRequest.ai_request_path, '/responses', 'Endpoint responses');
  };

  const runMockedScenario = async (scenario) => {
    const input = readSample(scenario.sample);
    const request = await runCode('Build AI Request', input, {}, env);
    let calls = 0;
    const helpers = {
      httpRequest: async (options) => {
        calls += 1;
        expectEqual(options.url, 'https://integrate.api.nvidia.com/v1/chat/completions', `${scenario.name} URL`);
        expectEqual(options.headers.Authorization, 'Bearer test-key', `${scenario.name} Authorization`);
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
    body: makeChatBody({
      ...baseResponse,
      intent: 'greeting',
      lead_quality: 'none',
      confidence: 0.91,
      reply_text: 'Hola, gracias por escribirnos. ¿Desde que ciudad nos escribes?',
    }),
    expect: (result) => {
      expectEqual(result.intent, 'greeting', 'saludo intent');
      expectIncludes(result.missing_fields, 'service', 'saludo missing service');
      expectIncludes(result.missing_fields, 'confirmation', 'saludo missing confirmation');
      expectEqual(result.should_create_lead, false, 'saludo no crea lead');
    },
  });

  await runMockedScenario({
    name: 'completo sin confirmacion',
    sample: 'ai_complete_without_confirmation.sample.json',
    body: makeChatBody({
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
      expectEqual(result.service, 'Baldosas', 'completo sin confirmacion service');
      expectEqual(result.city, 'Santiago', 'completo sin confirmacion city');
      expectEqual(result.requirement, 'Renovar un baño', 'completo sin confirmacion requirement');
      expectIncludes(result.missing_fields, 'confirmation', 'completo sin confirmacion missing confirmation');
      expectEqual(result.model_should_create_lead_raw, true, 'completo sin confirmacion raw model flag');
      expectEqual(result.should_create_lead, false, 'guardrail sin confirmacion');
      expectEqual(result.clickup_summary, '', 'sin confirmacion no expone resumen ClickUp');
    },
  });

  await runMockedScenario({
    name: 'completo con confirmacion',
    sample: 'ai_complete_with_confirmation.sample.json',
    body: makeChatBody({
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
    }, 'array'),
    expect: (result) => {
      expectEqual(result.intent, 'confirmation_yes', 'completo con confirmacion intent');
      expectEqual(result.confirmation_status, 'confirmed', 'completo con confirmacion status');
      expectEqual(result.should_create_lead, true, 'completo con confirmacion crea lead');
      expectEqual(result.clickup_summary.includes('Cliente confirmado'), true, 'completo con confirmacion resumen');
    },
  });

  await runMockedScenario({
    name: 'correccion',
    sample: 'ai_correction.sample.json',
    body: makeChatBody({
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
    body: makeChatBody({
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
      expectEqual(result.reply_text, '', 'baja confianza no expone reply_text del modelo');
      expectEqual(result.should_create_lead, false, 'ambiguo no crea lead');
    },
  });

  await runMockedScenario({
    name: 'respuesta invalida',
    sample: 'ai_complete_without_confirmation.sample.json',
    body: makeChatBody('esto no es json'),
    expect: (result) => {
      expectEqual(result.ai_fallback_reason, 'invalid_json', 'invalido fallback seguro');
      expectEqual(Boolean(result.ai_parse_error), true, 'invalido registra parse error');
      expectEqual(result.service, '', 'invalido no acepta service');
      expectEqual(result.city, '', 'invalido no acepta city');
      expectEqual(result.requirement, '', 'invalido no acepta requirement');
      expectEqual(result.should_create_lead, false, 'invalido no crea lead');
    },
  });

  const skippedRequest = await runCode('Build AI Request', readSample('ai_greeting.sample.json'), {}, { AI_LEAD_ASSISTANT_ENABLED: 'false', AI_MODEL: 'minimaxai/minimax-m2.5' });
  const skippedCall = await runCode('Call AI Provider', skippedRequest, {}, {});
  const skipped = await runCode('Normalize AI Result', skippedCall, {}, {});
  assert(skipped.ai_skipped && skipped.ai_skip_reason === 'disabled', 'Modo disabled no funciona');
  expectEqual(skipped.should_create_lead, false, 'disabled no crea lead');

  console.log('AI assistant local contract OK: 7 escenarios mock sin llamar proveedor real');
})();
NODE
