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
    AI_PROVIDER: 'direct_api',
    AI_API_KEY_REQUIRED: 'true',
    AI_DIRECT_API_BASE_URL: 'https://api.openai.com/v1',
    AI_DIRECT_API_PATH: '/responses',
    AI_DIRECT_API_KEY: 'test-direct-api-key',
    AI_DIRECT_API_MODEL: 'test-fast-model',
    AI_DIRECT_API_TIMEOUT_MS: '8000',
    EXTERNAL_HTTP_MAX_ATTEMPTS: '2',
    EXTERNAL_HTTP_RETRY_BASE_MS: '1',
    EXTERNAL_HTTP_RETRY_MAX_MS: '1',
  };

  const baseResponse = {
    intent: 'unknown',
    lead_quality: 'none',
    customer_type: 'unknown',
    lead_class: 'none',
    modality: 'unknown',
    service: '',
    city: '',
    requirement: '',
    missing_fields: ['service', 'city', 'requirement', 'confirmation'],
    commercial_missing_fields: [],
    diagnostic_datos: { pain: '', scope: '', timing: '', obstacle: '', next_step: '' },
    confirmation_status: 'none',
    should_create_lead: false,
    needs_confirmation: true,
    confidence: 0.8,
    reply_text: '',
    objection_detected: 'none',
    escalation_area: 'none',
    next_best_action: 'ask_data',
    handoff_reason: '',
    executive_summary: '',
    clickup_summary: '',
  };

  const makeDirectApiBody = (payload) => ({
    output_text: typeof payload === 'string' ? payload : JSON.stringify(payload),
  });

  const validateRequestContract = async () => {
    const request = await runCode('Build AI Request', readSample('ai_lead_qualification.sample.json'), {}, env);
    const schema = request.response_schema;
    assert(schema, 'No se expone JSON Schema para Hormi Atencion');
    expectEqual(request.ai_provider, 'direct_api', 'Proveedor API directa');
    expectEqual(request.ai_api_mode, 'openai_responses', 'Modo API directa');
    expectEqual(request.ai_request_path, '/responses', 'Endpoint API directa');
    expectEqual(request.ai_base_url, 'https://api.openai.com/v1', 'Base URL API directa');
    expectEqual(request.ai_model, 'test-fast-model', 'Modelo API directa');
    expectEqual(request.ai_request.model, 'test-fast-model', 'Modelo en request');
    assert(request.ai_request.input[0].content.includes('Tienes autonomia conversacional'), 'Prompt no declara autonomia');
    expectEqual(request.ai_request.text.format.strict, true, 'Salida estructurada estricta');
    expectIncludes(schema.required, 'confirmation_status', 'Contrato debe exigir confirmation_status');
    expectIncludes(schema.required, 'lead_class', 'Contrato debe exigir clasificacion A/B/C/D');
    expectIncludes(schema.required, 'diagnostic_datos', 'Contrato debe exigir diagnostico D.A.T.O.S.');
    expectIncludes(schema.required, 'executive_summary', 'Contrato debe exigir resumen ejecutivo');
    assert(
      request.ai_request.input[0].content.includes('D.A.T.O.S.'),
      'Prompt no incorpora metodo D.A.T.O.S.'
    );
    assert(
      request.ai_request.input[0].content.includes('Clasifica el lead'),
      'Prompt no incorpora clasificacion comercial'
    );
    expectEqual(schema.additionalProperties, false, 'Contrato debe rechazar propiedades extra');

    const commercialRequest = await runCode('Build AI Request', {
      ...readSample('ai_complete_without_confirmation.sample.json'),
      commercial_context: {
        catalog_items: [
          {
            id: 3,
            sku: 'adoquin',
            name: 'Adoquin',
            price_rules: [
              {
                code: 'adoquin-fixed',
                price_type: 'fixed',
                currency: 'CLP',
                amount: 1300,
                unit: 'm2',
              },
            ],
          },
        ],
        conditions: [],
        faqs: [],
        objections: [],
        available_slots: [],
      },
    }, {}, env);
    expectEqual(commercialRequest.commercial_context_counts.catalog_items, 1, 'Contexto comercial cuenta catalogo');
    assert(
      commercialRequest.ai_request.input[1].content.includes('commercial_context_available'),
      'Prompt no incluye disponibilidad de contexto comercial'
    );
    assert(
      commercialRequest.ai_request.input[1].content.includes('adoquin-fixed'),
      'Prompt no incluye reglas de precio publicas'
    );
  };

  const runMockedScenario = async (scenario) => {
    const input = readSample(scenario.sample);
    const request = await runCode('Build AI Request', input, {}, env);
    let calls = 0;
    const helpers = {
      httpRequest: async (options) => {
        calls += 1;
        expectEqual(options.url, 'https://api.openai.com/v1/responses', `${scenario.name} URL`);
        expectEqual(options.headers.Authorization, 'Bearer test-direct-api-key', `${scenario.name} Authorization`);
        expectEqual(options.timeout, 8000, `${scenario.name} timeout`);
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
    body: makeDirectApiBody({
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
    body: makeDirectApiBody({
      ...baseResponse,
      intent: 'quote_request',
      lead_quality: 'high',
      customer_type: 'b2c',
      lead_class: 'A',
      modality: 'installation',
      service: 'Baldosas',
      city: 'Santiago',
      requirement: 'Renovar un baño',
      missing_fields: ['confirmation'],
      commercial_missing_fields: ['measurements', 'photos', 'terrain', 'debris_removal'],
      diagnostic_datos: {
        pain: 'Renovar baño',
        scope: 'Baldosas con instalacion por definir',
        timing: 'No informado',
        obstacle: 'Faltan medidas y fotos',
        next_step: 'Pedir confirmacion y datos de instalacion',
      },
      confirmation_status: 'requested',
      should_create_lead: true,
      confidence: 0.93,
      reply_text: 'Tengo los datos. ¿Esta correcto?',
      objection_detected: 'none',
      escalation_area: 'sales',
      next_best_action: 'confirm',
      executive_summary: 'Cliente B2C consulta instalacion de baldosas en Santiago; faltan medidas y fotos.',
      clickup_summary: 'No deberia pasar a ClickUp sin confirmacion.',
    }),
    expect: (result) => {
      expectEqual(result.service, 'Baldosas', 'sin confirmacion service');
      expectIncludes(result.missing_fields, 'confirmation', 'sin confirmacion missing confirmation');
      expectEqual(result.model_should_create_lead_raw, true, 'modelo pidio crear lead');
      expectEqual(result.should_create_lead, false, 'guardrail sin confirmacion');
      expectEqual(result.clickup_summary, '', 'sin confirmacion no expone resumen ClickUp');
      expectEqual(result.lead_class, 'A', 'clasificacion A conservada');
      expectEqual(result.modality, 'installation', 'modalidad conservada');
      expectIncludes(result.commercial_missing_fields, 'measurements', 'faltantes comerciales');
      expectEqual(result.diagnostic_datos.pain, 'Renovar baño', 'diagnostico D.A.T.O.S.');
      expectEqual(result.escalation_area, 'sales', 'area de escalamiento');
    },
  });

  await runMockedScenario({
    name: 'completo con confirmacion',
    sample: 'ai_complete_with_confirmation.sample.json',
    body: makeDirectApiBody({
      ...baseResponse,
      intent: 'confirmation_yes',
      lead_quality: 'high',
      customer_type: 'b2c',
      lead_class: 'B',
      modality: 'material',
      service: 'Baldosas',
      city: 'Santiago',
      requirement: 'Renovar un baño',
      missing_fields: [],
      commercial_missing_fields: [],
      diagnostic_datos: {
        pain: 'Renovar baño',
        scope: 'Baldosas para baño',
        timing: 'No informado',
        obstacle: '',
        next_step: 'Derivar a ventas',
      },
      confirmation_status: 'confirmed',
      should_create_lead: true,
      needs_confirmation: false,
      confidence: 0.96,
      reply_text: 'Perfecto, derivare tu solicitud.',
      objection_detected: 'none',
      escalation_area: 'sales',
      next_best_action: 'handoff_sales',
      executive_summary: 'Cliente confirmado solicita baldosas en Santiago para renovar un baño.',
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
    body: makeDirectApiBody({
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
    body: makeDirectApiBody({
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
    body: makeDirectApiBody('esto no es json'),
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

  const missingConfigRequest = await runCode('Build AI Request', readSample('ai_greeting.sample.json'), {}, {
    AI_LEAD_ASSISTANT_ENABLED: 'true',
    AI_PROVIDER: 'direct_api',
    AI_DIRECT_API_KEY: '__PENDIENTE__',
    AI_DIRECT_API_MODEL: '__PENDIENTE__',
  });
  const missingConfigCall = await runCode('Call AI Provider', missingConfigRequest, {}, {});
  const missingConfig = await runCode('Normalize AI Result', missingConfigCall, {}, {});
  assert(missingConfig.ai_skipped && missingConfig.ai_skip_reason === 'missing_api_config', 'Config pendiente debe omitir IA');
  expectEqual(missingConfig.should_create_lead, false, 'config pendiente no crea lead');

  console.log('AI assistant local contract OK: 8 escenarios API directa mock sin llamar proveedor real');
})();
NODE
