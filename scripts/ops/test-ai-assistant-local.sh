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
    explicitly_mentioned_fields: [],
  };

  const makeProviderBody = (payload) => ({
    output_text: typeof payload === 'string' ? payload : JSON.stringify(payload),
  });

  const validateRequestContract = async () => {
    const request = await runCode('Build AI Request', readSample('ai_lead_qualification.sample.json'), {}, env);
    const schema = request.response_schema;
    assert(schema, 'No se expone JSON Schema para Hormi Atencion');
    expectEqual(request.ai_skipped, false, 'La AI no debe quedar marcada como omitida');
    expectEqual(request.ai_provider, 'direct_api', 'Proveedor API directa');
    expectEqual(request.ai_api_mode, 'responses', 'Modo API directa');
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
    expectIncludes(schema.required, 'explicitly_mentioned_fields', 'Contrato debe exigir trazabilidad de campos explicitos');
    assert(request.ai_request.input[0].content.includes('D.A.T.O.S.'), 'Prompt no incorpora metodo D.A.T.O.S.');
    assert(request.ai_request.input[0].content.includes('Clasifica el lead'), 'Prompt no incorpora clasificacion comercial');
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

  const validateConfigFallback = async () => {
    const request = await runCode('Build AI Request', readSample('ai_greeting.sample.json'), {}, {
      ...env,
      AI_DIRECT_API_KEY: '__PENDIENTE__',
      AI_DIRECT_API_MODEL: '__PENDIENTE__',
    });
    expectEqual(request.ai_skipped, false, 'Config pendiente no debe apagar la AI');
    expectEqual(request.ai_request_error, 'missing_api_config', 'Debe marcar error de configuracion');

    const called = await runCode('Call AI Provider', request, {}, env);
    expectEqual(called.ai_status_code, 0, 'Config pendiente debe producir status local 0');

    const normalized = await runCode('Normalize AI Result', called, {}, env);
    expectEqual(normalized.ai_request_error, 'missing_api_config', 'Normalize debe conservar request_error');
    expectEqual(normalized.ai_fallback_reason, 'missing_api_config', 'Fallback debe exponer error de configuracion');
    expectEqual(normalized.should_create_lead, false, 'Config pendiente no crea lead');
  };

  const runSimulatedScenario = async (scenario) => {
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
  await validateConfigFallback();

  await runSimulatedScenario({
    name: 'saludo',
    sample: 'ai_greeting.sample.json',
    body: makeProviderBody({
      ...baseResponse,
      intent: 'greeting',
      confidence: 0.91,
      reply_text: 'Hola, gracias por escribirnos. ¿Desde que ciudad nos escribes?',
    }),
    expect: (result) => {
      expectEqual(result.intent, 'greeting', 'saludo intent');
      expectIncludes(result.missing_fields, 'service', 'saludo missing service');
      expectEqual(result.should_create_lead, false, 'saludo no crea lead');
    },
  });

  await runSimulatedScenario({
    name: 'completo sin confirmacion',
    sample: 'ai_complete_without_confirmation.sample.json',
    body: makeProviderBody({
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
        next_step: 'Confirmar datos y pedir medidas',
      },
      confidence: 0.94,
      reply_text: 'Tengo esto:\nServicio: Baldosas\nCiudad: Santiago\nRequerimiento: Renovar un baño\n\n¿Está correcto?',
      escalation_area: 'sales',
      next_best_action: 'confirm',
      executive_summary: 'Cliente B2C solicita baldosas en Santiago; faltan medidas y confirmacion.',
      explicitly_mentioned_fields: ['service', 'city', 'requirement'],
    }),
    expect: (result) => {
      expectEqual(result.service, 'Baldosas', 'completo service');
      expectEqual(result.city, 'Santiago', 'completo city');
      expectEqual(result.requirement, 'Renovar un baño', 'completo requirement');
      expectEqual(result.should_create_lead, false, 'sin confirmacion no crea lead');
      expectEqual(result.lead_class, 'A', 'clasificacion comercial');
      expectEqual(result.modality, 'installation', 'modalidad');
      expectIncludes(result.missing_fields, 'confirmation', 'debe pedir confirmacion');
    },
  });

  await runSimulatedScenario({
    name: 'confirmacion',
    sample: 'ai_complete_with_confirmation.sample.json',
    body: makeProviderBody({
      ...baseResponse,
      intent: 'confirmation_yes',
      lead_quality: 'high',
      customer_type: 'b2c',
      lead_class: 'A',
      modality: 'installation',
      service: 'Baldosas',
      city: 'Santiago',
      requirement: 'Renovar un baño',
      missing_fields: [],
      confirmation_status: 'confirmed',
      should_create_lead: true,
      needs_confirmation: false,
      confidence: 0.97,
      reply_text: 'Perfecto, derivaré tu solicitud a un asesor.',
      clickup_summary: 'Cliente solicita baldosas en Santiago para renovar un baño.',
      diagnostic_datos: {
        pain: 'Renovar baño',
        scope: 'Baldosas para baño',
        timing: 'No informado',
        obstacle: 'Ninguno',
        next_step: 'Derivar a ventas',
      },
      next_best_action: 'handoff_sales',
      executive_summary: 'Lead confirmado para baldosas en Santiago.',
      explicitly_mentioned_fields: [],
    }),
    expect: (result) => {
      expectEqual(result.intent, 'confirmation_yes', 'confirmacion intent');
      expectEqual(result.confirmation_status, 'confirmed', 'confirmacion status');
      expectEqual(result.should_create_lead, true, 'confirmacion crea lead');
      expectEqual(result.clickup_summary.length > 0, true, 'confirmacion expone resumen ClickUp');
    },
  });

  await runSimulatedScenario({
    name: 'correccion',
    sample: 'ai_correction.sample.json',
    body: makeProviderBody({
      ...baseResponse,
      intent: 'correction',
      lead_quality: 'medium',
      customer_type: 'b2c',
      lead_class: 'B',
      modality: 'installation',
      service: 'Baldosas',
      city: 'Valparaiso',
      requirement: 'Renovar un baño',
      missing_fields: ['confirmation'],
      confirmation_status: 'requested',
      confidence: 0.93,
      reply_text: 'Perfecto, actualizo la ciudad a Valparaiso. ¿Está correcto?',
      diagnostic_datos: {
        pain: 'Renovar baño',
        scope: 'Baldosas con instalacion',
        timing: 'No informado',
        obstacle: 'Solo faltaba corregir ciudad',
        next_step: 'Volver a confirmar',
      },
      next_best_action: 'confirm',
      executive_summary: 'Cliente corrigio ciudad a Valparaiso.',
      explicitly_mentioned_fields: ['city'],
    }),
    expect: (result) => {
      expectEqual(result.intent, 'correction', 'correccion intent');
      expectEqual(result.city, 'Valparaiso', 'correccion city');
      expectEqual(result.should_create_lead, false, 'correccion no crea lead');
      expectIncludes(result.missing_fields, 'confirmation', 'correccion mantiene confirmacion');
    },
  });

  await runSimulatedScenario({
    name: 'baja confianza',
    sample: 'ai_ambiguous.sample.json',
    body: makeProviderBody({
      ...baseResponse,
      intent: 'unknown',
      service: 'Baldosas',
      confidence: 0.41,
      reply_text: 'Cuéntame un poco más de lo que necesitas.',
      explicitly_mentioned_fields: [],
    }),
    expect: (result) => {
      expectEqual(result.ai_fallback_reason, 'low_confidence', 'baja confianza fallback');
      expectEqual(result.service, '', 'baja confianza no acepta service');
      expectEqual(result.reply_text, '', 'baja confianza no expone reply autonoma');
      expectEqual(result.should_create_lead, false, 'baja confianza no crea lead');
    },
  });

  await runSimulatedScenario({
    name: 'json invalido',
    sample: 'ai_complete_without_confirmation.sample.json',
    body: makeProviderBody('respuesta no json'),
    expect: (result) => {
      expectEqual(result.ai_parse_error, 'json_object_not_found', 'json invalido parse error');
      expectEqual(result.ai_fallback_reason, 'invalid_json', 'json invalido fallback');
      expectEqual(result.should_create_lead, false, 'json invalido no crea lead');
    },
  });

  console.log('AI assistant local contract OK: 7 escenarios simulados + fallback de configuracion');
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
NODE
