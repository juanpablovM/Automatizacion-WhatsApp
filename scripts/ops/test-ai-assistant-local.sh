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
    expectIncludes(
      schema.properties.explicitly_mentioned_fields.items.enum,
      'product',
      'Contrato debe permitir marcar la mencion directa de producto'
    );
    assert(request.ai_request.input[0].content.includes('D.A.T.O.S.'), 'Prompt no incorpora metodo D.A.T.O.S.');
    assert(request.ai_request.input[0].content.includes('Clasifica el lead'), 'Prompt no incorpora clasificacion comercial');
    assert(
      request.ai_request.input[0].content.includes('CLASIFICACION PRODUCTO vs SERVICIO'),
      'Prompt no incorpora la regla de clasificacion product vs service'
    );
    assert(
      request.ai_request.input[0].content.includes('Hormigon Armado Losa'),
      'Prompt no ejemplifica que "Hormigon Armado Losa" es un producto'
    );
    expectEqual(schema.additionalProperties, false, 'Contrato debe rechazar propiedades extra');

    const serializedHistory = JSON.stringify([
      { role: 'assistant', content: 'mensaje descartado por limite' },
      ...Array.from({ length: 8 }, (_, index) => ({
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `mensaje ${index + 1}`,
      })),
      { role: 'system', content: 'rol no permitido se normaliza a user' },
      { role: 'assistant', content: '   ' },
    ]);
    const memoryRequest = await runCode('Build AI Request', {
      ...readSample('ai_greeting.sample.json'),
      recent_messages: serializedHistory,
    }, {}, env);
    const memoryContext = memoryRequest.ai_context.recent_messages;
    expectEqual(memoryContext.length, 8, 'Historial AI debe limitarse a ocho mensajes validos');
    expectEqual(memoryContext[0].content, 'mensaje 2', 'Historial AI debe conservar los ocho mensajes mas recientes');
    expectEqual(memoryContext[7].role, 'user', 'Roles no permitidos deben normalizarse de forma segura');
    assert(
      !memoryRequest.ai_request.input[1].content.includes('mensaje descartado por limite'),
      'Mensaje fuera de la ventana no debe entrar al prompt'
    );
    assert(
      memoryRequest.ai_request.input[1].content.includes('rol no permitido se normaliza a user'),
      'Historial normalizado debe incluirse en el prompt'
    );

    const mergedRequest = await runCode('Build AI Request', {
      commercial_context: {
        catalog_items: [],
        conditions: [],
        faqs: [],
        objections: [],
        available_slots: [],
      },
      text_body_1: 'Necesito precio del metro lineal de solerilla',
      message_type_1: 'text',
      conversation_status_code_1: 'waiting_user',
      current_step_1: 'city',
      service_1: 'Solerilla',
      city_1: '',
      requirement_1: 'Cotizar solerilla',
      recent_messages_1: [
        { role: 'user', content: 'Quiero cotizar solerillas' },
        { role: 'assistant', content: '¿En que comuna las necesitas?' },
      ],
    }, {}, env);
    expectEqual(
      mergedRequest.ai_context.message_current,
      'Necesito precio del metro lineal de solerilla',
      'Build AI Request debe recuperar el mensaje sufijado por Merge'
    );
    expectEqual(mergedRequest.ai_context.existing_fields.service, 'Solerilla', 'Debe recuperar servicio sufijado');
    expectEqual(mergedRequest.ai_context.current_step, 'city', 'Debe recuperar current_step sufijado');
    expectEqual(mergedRequest.ai_context.recent_messages.length, 2, 'Debe recuperar historial sufijado');
    assert(
      mergedRequest.ai_request.input[1].content.includes('Necesito precio del metro lineal de solerilla'),
      'El prompt debe contener el mensaje real despues del Merge'
    );

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

    const chatRequest = await runCode('Build AI Request', {
      ...readSample('ai_complete_without_confirmation.sample.json'),
      recent_messages: Array.from({ length: 8 }, (_, index) => ({
        role: index % 2 ? 'assistant' : 'user',
        content: `Mensaje de contexto ${index + 1}`,
      })),
      commercial_context: {
        catalog_items: Array.from({ length: 8 }, (_, index) => ({
          id: index + 1,
          sku: `producto-${index + 1}`,
          name: `Producto ${index + 1}`,
          short_description: 'Descripcion comercial breve',
          metadata: { internal_notes: 'no debe enviarse' },
          price_rules: [{ code: `precio-${index + 1}`, price_type: 'reference', amount: 1000 + index }],
        })),
        conditions: Array.from({ length: 8 }, (_, index) => ({
          code: `condicion-${index + 1}`,
          title: `Condicion ${index + 1}`,
          condition_type: 'delivery',
          body: 'Condicion comercial oficial',
        })),
        faqs: [],
        objections: [],
        available_slots: [],
      },
    }, {}, {
      ...env,
      AI_PROVIDER: 'nvidia',
      AI_DIRECT_API_BASE_URL: 'https://integrate.api.nvidia.com/v1',
      AI_DIRECT_API_PATH: '/chat/completions',
    });
    assert(chatRequest.ai_request_chars < 35000, `Prompt chat debe quedar compacto, recibido ${chatRequest.ai_request_chars}`);
    expectEqual(chatRequest.ai_context.commercial_context.catalog_items.length, 5, 'Contexto chat limita catalogo');
    assert(
      !chatRequest.ai_request.messages[1].content.includes('required_json_schema'),
      'Chat Completions no debe duplicar el JSON Schema completo'
    );
    assert(
      !chatRequest.ai_request.messages[1].content.includes('internal_notes'),
      'Contexto chat no debe enviar metadata interna innecesaria'
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

  const validateRateLimitHandling = async () => {
    const request = await runCode('Build AI Request', readSample('ai_greeting.sample.json'), {}, {
      ...env,
      AI_PROVIDER: 'nvidia',
      AI_DIRECT_API_BASE_URL: 'https://integrate.api.nvidia.com/v1',
      AI_DIRECT_API_PATH: '/chat/completions',
    });
    let calls = 0;
    const called = await runCode('Call AI Provider', request, {
      httpRequest: async () => {
        calls += 1;
        return {
          statusCode: 429,
          body: { status: 429, title: 'Too Many Requests' },
          headers: { 'retry-after': '0.001', 'x-ratelimit-remaining': '0' },
        };
      },
    }, {
      ...env,
      AI_DIRECT_API_MAX_ATTEMPTS: '2',
      AI_DIRECT_API_RETRY_BASE_MS: '1',
      AI_DIRECT_API_RETRY_MAX_MS: '2',
      AI_DIRECT_API_RATE_LIMIT_COOLDOWN_MS: '1000',
    });
    expectEqual(calls, 2, 'Rate limit debe usar el maximo AI especifico de intentos');
    expectEqual(called.ai_status_code, 429, 'Rate limit debe conservar HTTP 429');
    expectEqual(called.ai_retry_exhausted, true, 'Rate limit debe marcar reintentos agotados');
    expectEqual(called.ai_circuit_open, true, 'Rate limit debe abrir el circuit breaker');
    expectEqual(called.ai_response_headers.rate_limit_remaining, '0', 'Debe auditar headers de rate limit');

    const normalized = await runCode('Normalize AI Result', called, {}, env);
    expectEqual(normalized.ai_fallback_reason, 'rate_limited', 'Normalize debe distinguir rate limit');
    expectEqual(normalized.ai_circuit_open, true, 'Normalize debe conservar estado del circuito');
  };

  const validateV3ContractDispatch = async () => {
    const policy = {
      version: 'ai_prd_turn_policy/v3',
      policy_digest: 'a'.repeat(64),
      turn: {
        id: 'turn-v3-1',
        conversation_id: 'conversation-1',
        conversation_revision: 7,
        message: { id: 'message-1', text: 'Necesito 6 m² de baldosas en Ñuñoa.' },
      },
      history: { messages: [], truncated: false, sha256: 'b'.repeat(64) },
      facts: [],
      goals: [{ goal_id: 'modality', status: 'unresolved', importance: 'required_for_effect', blocks_effects: ['create_lead'] }],
      conversation_policy: {
        normal_voice: 'ai_only',
        max_primary_requests: 1,
        may_answer_before_progressing: true,
        may_defer_commercial_goals: true,
        must_not_request_known_facts: true,
      },
      state_authority: { allowed_mutations: [] },
      grounding: { catalog: [], modality_synonyms: [], snapshot_digest: 'c'.repeat(64) },
      claim_authority: { rules: [] },
      effect_authority: { permissions: [], requirements: [], operation_key_strategy: 'system_derived/v1' },
      commit_policy: { proposal_atomicity: 'all_or_nothing', effects_before_reply: true, delivery_idempotency: 'turn_reply/v1' },
      failure_policy: { max_repairs: 1, preserve_pre_turn_state: true, static_copy: 'contingency_only', handoff_after_exhaustion: true },
    };
    const request = await runCode('Build AI Request', {
      contract_version: 'v3',
      turn_policy: policy,
    }, {}, env);
    const schema = request.response_schema;
    expectEqual(request.ai_contract_version, 'v3', 'Dispatch v3 debe conservar la version contractual');
    expectEqual(schema.additionalProperties, false, 'Schema v3 debe rechazar propiedades extra');
    for (const key of ['version', 'policy_digest', 'reply_text', 'primary_request', 'observations', 'state_mutations', 'effect_requests']) {
      expectIncludes(schema.required, key, `Schema v3 debe exigir ${key}`);
    }
    assert(!schema.properties.confidence, 'Schema v3 no debe usar confidence para autorizar');
    assert(!schema.properties.next_question_key, 'Schema v3 no debe prescribir la siguiente pregunta');
    expectEqual(schema.properties.primary_request.type.includes('null'), true, 'primary_request v3 debe permitir cero solicitudes');
    const serializedRequest = JSON.stringify(request.ai_request);
    assert(serializedRequest.includes('ai_conversation_proposal/v3'), 'Prompt v3 debe pedir el contrato versionado');
    assert(serializedRequest.includes(policy.policy_digest), 'Prompt v3 debe ligar la propuesta a la policy');
    assert(!serializedRequest.includes('advisorQuestion'), 'Prompt v3 no debe exponer copy determinista');

    const replyText = 'Perfecto 👷, son 6 m² en Ñuñoa.\n¿Buscás solo material o instalación?';
    const proposal = {
      version: 'ai_conversation_proposal/v3',
      policy_digest: policy.policy_digest,
      reply_text: replyText,
      primary_request: { text: '¿Buscás solo material o instalación?', goal_id: 'modality' },
      observations: [],
      state_mutations: [],
      effect_requests: [],
    };
    const normalized = await runCode('Normalize AI Result', {
      ...request,
      ai_status_code: 200,
      ai_response: makeProviderBody(proposal),
    }, {}, env);
    expectEqual(normalized.ai_contract_version, 'v3', 'Normalize debe despachar por v3');
    expectEqual(normalized.ai_proposal.version, 'ai_conversation_proposal/v3', 'Normalize debe conservar el envelope v3');
    expectEqual(normalized.ai_proposal.reply_text, replyText, 'Normalize debe preservar bytes del reply v3');
    expectEqual(normalized.reply_text, replyText, 'Reply visible normalizado debe conservar bytes v3');
    expectEqual(normalized.ai_parse_error, null, 'Propuesta v3 valida no debe generar parse error');

    const invalidPolicyRequest = await runCode('Build AI Request', {
      contract_version: 'v3',
      turn_policy: {},
    }, {}, env);
    expectEqual(invalidPolicyRequest.ai_request, null, 'Dispatch v3 debe fallar cerrado sin policy valida');
    expectEqual(invalidPolicyRequest.ai_request_error, 'invalid_turn_policy', 'Dispatch v3 debe explicar policy invalida');

    const wrapped = await runCode('Normalize AI Result', {
      ...request,
      ai_status_code: 200,
      ai_response: makeProviderBody(`\`\`\`json\n${JSON.stringify(proposal)}\n\`\`\``),
    }, {}, env);
    expectEqual(wrapped.ai_proposal, null, 'Normalize v3 no debe reparar Markdown silenciosamente');
    expectEqual(wrapped.ai_fallback_reason, 'invalid_json', 'Normalize v3 debe rechazar sintaxis no contractual');
  };

  const runSimulatedScenario = async (scenario) => {
    const input = scenario.input || readSample(scenario.sample);
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
  await validateRateLimitHandling();
  await validateV3ContractDispatch();

  await runSimulatedScenario({
    name: 'rechaza saludo incoherente ante consulta de precio',
    input: {
      ...readSample('ai_greeting.sample.json'),
      message_current: 'Necesito precio del metro lineal de solerilla',
      text_body: 'Necesito precio del metro lineal de solerilla',
      service: 'Solerilla',
    },
    body: makeProviderBody({
      ...baseResponse,
      intent: 'greeting',
      sales_stage: 'greeting',
      confidence: 0.99,
      reply_text: 'Hola, ¿en que puedo ayudarte?',
    }),
    expect: (result) => {
      expectEqual(result.intent, 'price_inquiry', 'Guardrail debe inferir intencion comercial');
      expectEqual(result.ai_fallback_reason, 'intent_mismatch', 'Guardrail debe marcar incoherencia de intencion');
      expectEqual(result.reply_text, '', 'Respuesta incoherente no debe llegar al orquestador');
    },
  });

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
      // Regla PRD (clasificacion product vs service): "cotizar baldosas" sin
      // evidencia de servicio -> la modalidad no se infiere (unknown).
      expectEqual(result.modality, 'unknown', 'modalidad sin servicio no se infiere (product only)');
      expectEqual(result.field_updates.product, 'Baldosas', 'mencion directa de producto satisface el campo');
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

  await runSimulatedScenario({
    name: 'hormigon armado losa es producto',
    input: {
      ...readSample('ai_greeting.sample.json'),
      message_current: 'Necesito hormigon armado losa para una losa de 100 m2',
      text_body: 'Necesito hormigon armado losa para una losa de 100 m2',
    },
    body: makeProviderBody({
      ...baseResponse,
      intent: 'installation_inquiry',
      lead_quality: 'high',
      customer_type: 'b2c',
      lead_class: 'A',
      modality: 'installation',
      service: 'Hormigon',
      city: '',
      requirement: '',
      confidence: 0.95,
      reply_text: 'Para instalacion necesitamos revisar medidas y terreno.',
      explicitly_mentioned_fields: [],
    }),
    expect: (result) => {
      // Regla PRD (clasificacion product vs service): "Hormigon Armado Losa"
      // es un PRODUCTO; sin evidencia de servicio la consulta es de cotizacion
      // y la modalidad no se infiere.
      expectEqual(result.intent, 'quote_request', 'producto sin servicio reclasifica a quote_request');
      expectEqual(result.modality, 'unknown', 'producto sin servicio no infiere modalidad');
      expectEqual(result.field_updates.product, 'Hormigon Armado Losa', 'mencion literal de producto completa el campo');
    },
  });

  await runSimulatedScenario({
    name: 'suministro implica solo material',
    input: {
      ...readSample('ai_greeting.sample.json'),
      message_current: 'Necesito suministro de adoquines, solo material',
      text_body: 'Necesito suministro de adoquines, solo material',
    },
    body: makeProviderBody({
      ...baseResponse,
      intent: 'installation_inquiry',
      lead_quality: 'medium',
      customer_type: 'b2c',
      lead_class: 'B',
      modality: 'installation',
      service: 'Adoquines',
      confidence: 0.92,
      reply_text: 'Te puedo ayudar con eso.',
      explicitly_mentioned_fields: [],
    }),
    expect: (result) => {
      // Regla PRD (clasificacion product vs service): "suministro" /
      // "solo material" es el servicio de material -> modalidad material,
      // aunque el modelo haya inferido instalacion.
      expectEqual(result.modality, 'material', 'suministro/solo material impone modalidad material');
      expectEqual(result.field_updates.product, 'Adoquines', 'mencion de adoquines completa el campo');
    },
  });

  console.log('AI assistant local contract OK: v3 dispatch + 9 escenarios simulados + fallback de configuracion');
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
NODE
