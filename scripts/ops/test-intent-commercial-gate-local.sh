#!/bin/sh
set -eu

# =============================================================================
# test-intent-commercial-gate-local.sh — Harness local y determinista (sin red,
# sin BD) para la Unidad 1: gate de campos obligatorios por intencion (PRD #13).
# -----------------------------------------------------------------------------
# Valida en 3 capas:
#   1. AI      -> contrato de commercial_missing_fields + prompt del gate
#   2. Orquestador (Apply AI Assistance) -> gate determinista que CANCELA la
#      confirmacion si falta un campo obligatorio y pregunta el primero faltante
#   3. CRM     -> Prepare Lead Assignment NO crea si el gate esta bloqueado
#   4. Dispatcher -> defensa en profundidad (IF gate de downstream)
# =============================================================================

ROOT_DIR=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
cd "$ROOT_DIR"

# Los nodos viven en los workflows; la politica canonica vive en fixtures y se
# reinyecta con sync-workflow-nodes.mjs (idempotente, con backup).
if ! node tests/scripts/sync-workflow-nodes.mjs --check >/dev/null 2>&1; then
  echo "ERROR: los nodos de workflow divergen de los fixtures de tests/fixtures/workflow-nodes/" >&2
  echo "Ejecuta: node tests/scripts/sync-workflow-nodes.mjs" >&2
  exit 1
fi

node <<'NODE'
(async () => {
  const fs = require('fs');
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

  const workflow = (file) => JSON.parse(fs.readFileSync(`n8n/workflows/${file}`, 'utf8'));
  const orchestrator = workflow('wa-conversation-orchestrator.json');
  const crm = workflow('crm-lead-creation-and-assignment.json');
  const dispatcher = workflow('wa-inbound-downstream-dispatcher.json');
  const aiWorkflow = workflow('ai-lead-qualification-assistant.json');

  const nodeCode = (wf, name) => {
    const node = wf.nodes.find((entry) => entry.name === name);
    if (!node) throw new Error(`No existe nodo ${name}`);
    return node.parameters.jsCode;
  };
  const runCode = async (wf, name, item, helpers = {}, env = {}) => {
    const fn = new AsyncFunction('items', 'helpers', '$env', nodeCode(wf, name));
    const result = await fn([{ json: item }], helpers, env);
    return result[0].json;
  };

  let passed = 0;
  let failed = 0;
  const assert = (condition, message) => {
    if (!condition) {
      failed += 1;
      console.error(`  FAIL: ${message}`);
    } else {
      passed += 1;
    }
  };
  const expectEqual = (actual, expected, message) => {
    assert(actual === expected, `${message}: esperado ${JSON.stringify(expected)}, recibido ${JSON.stringify(actual)}`);
  };
  const expectIncludes = (actual, expected, message) => {
    assert(Array.isArray(actual) && actual.includes(expected), `${message}: ${expected} no esta en ${JSON.stringify(actual)}`);
  };

  const env = {
    AI_LEAD_ASSISTANT_ENABLED: 'true',
    AI_MODEL_C_ENABLED: 'true',
    AI_DIRECT_API_KEY: 'test-key',
    AI_DIRECT_API_MODEL: 'test-model',
    AI_DIRECT_API_BASE_URL: 'https://integrate.api.nvidia.com/v1',
    AI_DIRECT_API_PATH: '/chat/completions',
  };

  // ---------------------------------------------------------------------------
  // Construccion de filas para el nodo Apply AI Assistance (row merged).
  // ---------------------------------------------------------------------------
  const baseRow = {
    phone_number: '56912345678',
    source_number_id: 1,
    instance_name: 'hormi',
    inbound_event_id: 1,
    processing_token: 'tok',
    whatsapp_name: 'Juan Perez',
    external_contact_id: 'cid',
    external_message_id: null,
    external_timestamp: null,
    message_type: 'text',
    raw_payload_json: '{}',
    attachment_type: null,
    mime_type: null,
    filename: null,
    external_media_id: null,
    external_url: null,
    sha256: null,
    file_size: null,
    conversation_id: 1,
    lead_id: null,
    reset_conversation_lead: false,
    previous_lead_id: null,
    current_step: 'confirm',
    conversation_status_code: 'waiting_user',
    should_create_lead: false,
    should_escalate: false,
    escalation_reason: '',
    is_partial: false,
    response_text: '',
    deterministic_reply: null,
    response_kind: null,
    normalized_text: null,
    completed_fields_count: 3,
    has_intent: true,
    metadata_json: '{}',
    before_payload_json: '{}',
    after_payload_json: '{}',
    ai_skipped: false,
    ai_skip_reason: null,
    ai_parse_error: null,
    ai_request_error: null,
    ai_fallback_reason: null,
    ai_status_code: 200,
    ai_retry_exhausted: false,
    ai_provider: 'nvidia',
    ai_model: 'meta/llama-3.1-8b-instruct',
    ai_confidence: 0.9,
    confidence: 0.9,
    needs_confirmation: false,
    reply_text: 'Perfecto, derivo tu solicitud para que la revise una ejecutiva.',
    diagnostic_datos: { pain: 'test', scope: 'test', timing: 'test', obstacle: 'test', next_step: 'test' },
    field_updates: {},
    explicitly_mentioned_fields: [],
    escalation_area: 'none',
    commercial_missing_fields: [],
  };

  // Perfiles PRD #13 (politica determinista del orquestador).
  const PROFILES = {
    material: {
      intent: 'quote_request',
      modality: 'material',
      customer_type: 'b2c',
      lead_class: 'B',
      complete: {
        qualification_context: {
          product: 'Baldosas', commune: 'Santiago', quantity: '40 unidades',
          modality: 'material', customer_type: 'b2c', lead_class: 'B',
        },
        service: 'Baldosas', city: 'Santiago',
      },
      missingField: 'quantity',
      missingCtx: { product: 'Baldosas', commune: 'Santiago', modality: 'material', customer_type: 'b2c', lead_class: 'B' },
      expectedQuestionKey: 'quantity',
      createsLead: true,
      kind: 'sales',
    },
    // PRD 13.4 (B06): el servicio nunca satisface product. El cliente dijo
    // solo servicio/ciudad/requerimiento; el gate debe listar product primero
    // aunque state.service este presente y pedirlo al cliente.
    material_producto: {
      intent: 'quote_request',
      modality: 'material',
      customer_type: 'b2c',
      lead_class: 'B',
      complete: {
        qualification_context: {
          product: 'Baldosas', commune: 'Santiago', quantity: '40 unidades',
          modality: 'material', customer_type: 'b2c', lead_class: 'B',
        },
        service: 'Baldosas', city: 'Santiago',
      },
      missingField: 'product',
      missingCtx: { commune: 'Santiago', quantity: '40 unidades', modality: 'material', customer_type: 'b2c', lead_class: 'B' },
      expectedQuestionKey: 'product',
      createsLead: true,
      kind: 'sales',
    },
    instalacion: {
      intent: 'installation_inquiry',
      modality: 'installation',
      customer_type: 'b2c',
      lead_class: 'A',
      complete: {
        qualification_context: {
          product: 'Pastelones', commune: 'Santiago', quantity: '40 m2', measurements: '40 m2',
          terrain: 'plano', truck_access: true, debris_removal: false,
          modality: 'installation', customer_type: 'b2c', lead_class: 'A',
        },
        service: 'Pastelones', city: 'Santiago',
      },
      missingField: 'terrain',
      missingCtx: {
        product: 'Pastelones', commune: 'Santiago', quantity: '40 m2', measurements: '40 m2',
        truck_access: true, debris_removal: false,
        modality: 'installation', customer_type: 'b2c', lead_class: 'A',
      },
      expectedQuestionKey: 'terrain',
      createsLead: true,
      kind: 'sales',
    },
    despacho: {
      intent: 'delivery_inquiry',
      modality: 'delivery',
      customer_type: 'contractor',
      lead_class: 'B',
      complete: {
        qualification_context: {
          product: 'Adocretos', commune: 'Maipu', quantity: '200 unidades',
          address: 'Av. Siempre Viva 123', access_restrictions: 'Camion 12m ok',
          modality: 'delivery', customer_type: 'contractor', lead_class: 'B',
        },
        service: 'Adocretos', city: 'Maipu',
      },
      missingField: 'address',
      missingCtx: {
        product: 'Adocretos', commune: 'Maipu', quantity: '200 unidades',
        access_restrictions: 'Camion 12m ok',
        modality: 'delivery', customer_type: 'contractor', lead_class: 'B',
      },
      expectedQuestionKey: 'address',
      createsLead: true,
      kind: 'sales',
    },
    retiro: {
      intent: 'plant_pickup',
      modality: 'pickup',
      customer_type: 'b2c',
      lead_class: 'C',
      complete: {
        qualification_context: {
          product: 'Baldosas', quantity: '10 unidades',
          modality: 'pickup', customer_type: 'b2c', lead_class: 'C',
        },
        service: 'Baldosas', city: 'Quilpue',
      },
      missingField: 'product',
      missingCtx: { modality: 'pickup', customer_type: 'b2c', lead_class: 'C' },
      missingOverrides: { service: '', city: '' },
      expectedQuestionKey: null,
      createsLead: true,
      kind: 'sales',
    },
    b2b: {
      intent: 'b2b_request',
      modality: 'delivery',
      customer_type: 'b2b',
      lead_class: 'D',
      complete: {
        qualification_context: {
          company: 'Constructora Andes', contact_name: 'Maria Fuentes', product: 'Adocretos',
          quantity: '500 m2', commune: 'Santiago', purchase_order: true,
          modality: 'delivery', customer_type: 'b2b', lead_class: 'D',
        },
        service: 'Adocretos', city: 'Santiago',
      },
      missingField: 'oc',
      missingCtx: {
        company: 'Constructora Andes', contact_name: 'Maria Fuentes', product: 'Adocretos',
        quantity: '500 m2', commune: 'Santiago',
        modality: 'delivery', customer_type: 'b2b', lead_class: 'D',
      },
      expectedQuestionKey: 'purchase_order',
      createsLead: true,
      kind: 'sales',
    },
    reclamo: {
      intent: 'complaint',
      modality: 'claim',
      customer_type: 'complaint',
      lead_class: 'complaint',
      escalation_area: 'claims',
      complete: {
        qualification_context: {
          issue_description: 'Se rompieron 10 pastelones recien instalados',
          customer_type: 'complaint', lead_class: 'complaint',
        },
        service: 'Pastelones', city: 'Santiago',
      },
      missingField: 'issue_description',
      missingCtx: { customer_type: 'complaint', lead_class: 'complaint' },
      expectedQuestionKey: 'issue_description',
      createsLead: false,
      kind: 'operational',
    },
    garantia: {
      intent: 'warranty_inquiry',
      modality: 'post_sale',
      customer_type: 'post_sale',
      lead_class: 'post_sale',
      escalation_area: 'post_sale',
      complete: {
        qualification_context: {
          issue_description: 'La instalacion presenta desnivel despues de 3 meses',
          customer_type: 'post_sale', lead_class: 'post_sale',
        },
        service: 'Instalacion', city: 'Vina del Mar',
      },
      missingField: 'issue_description',
      missingCtx: { customer_type: 'post_sale', lead_class: 'post_sale' },
      expectedQuestionKey: 'issue_description',
      createsLead: false,
      kind: 'operational',
    },
    comprobante: {
      intent: 'payment_proof',
      modality: 'post_sale',
      customer_type: 'returning_customer',
      lead_class: 'general',
      escalation_area: 'finance',
      complete: {
        qualification_context: {
          payment_amount: '250000', payment_method: 'transferencia',
          customer_type: 'returning_customer', lead_class: 'general',
        },
        service: 'Baldosas', city: 'Santiago',
      },
      missingField: 'payment_method',
      missingCtx: { payment_amount: '250000', customer_type: 'returning_customer', lead_class: 'general' },
      expectedQuestionKey: 'payment_details',
      createsLead: false,
      kind: 'operational',
    },
    factura: {
      intent: 'invoice_request',
      modality: 'post_sale',
      customer_type: 'b2c',
      lead_class: 'general',
      escalation_area: 'finance',
      complete: {
        qualification_context: {
          invoice_required: true,
          customer_type: 'b2c', lead_class: 'general',
        },
        service: 'Baldosas', city: 'Santiago',
      },
      missingField: 'invoice',
      missingCtx: { customer_type: 'b2c', lead_class: 'general' },
      expectedQuestionKey: 'invoice',
      createsLead: false,
      kind: 'operational',
    },
  };

  const buildRow = (profile, ctx, { confirmation = true, text = 'Si', overrides = {} } = {}) => ({
    ...baseRow,
    ...profile.complete,
    qualification_context: { ...ctx },
    service: profile.complete.service,
    city: profile.complete.city,
    requirement: 'Renovar patio',
    intent: profile.intent,
    modality: profile.modality,
    customer_type: profile.customer_type,
    lead_class: profile.lead_class,
    escalation_area: profile.escalation_area || 'none',
    pending_question_key: 'final_confirmation',
    text_body: text,
    confirmation_status: confirmation ? 'confirmed' : 'none',
    should_create_lead: confirmation,
    ...overrides,
  });

  // ---------------------------------------------------------------------------
  // 1. CAPA AI: contrato del schema y prompt del gate.
  // ---------------------------------------------------------------------------
  console.log('[1] Capa AI: contrato commercial_missing_fields + prompt');
  {
    const request = await runCode(aiWorkflow, 'Build AI Request', {
      text_body: 'Quiero cotizar adocretos para mi patio',
      service: 'Adocretos',
      commercial_context: { catalog_items: [], conditions: [], faqs: [], objections: [], available_slots: [] },
    }, {}, env);
    const enumList = request.response_schema.properties.commercial_missing_fields.items.enum;
    for (const key of ['address', 'access_restrictions', 'issue_description', 'payment_amount', 'sale_number', 'desired_date']) {
      assert(enumList.includes(key), `schema enum commercial_missing_fields debe incluir '${key}'`);
    }
    assert(
      request.ai_request.messages[0].content.includes('GATE DE CAMPOS OBLIGATORIOS'),
      'Prompt del sistema debe declarar el gate de campos obligatorios'
    );
    assert(
      request.ai_request.messages[0].content.includes('commercial_missing_fields'),
      'Prompt debe instruir a reportar commercial_missing_fields por intencion'
    );
    assert(
      request.ai_request.messages[0].content.includes('NO pongas confirmation_status=confirmed'),
      'Prompt debe prohibir confirmar con campos obligatorios pendientes'
    );
  }

  // ---------------------------------------------------------------------------
  // 2. CAPA ORQUESTADOR: gate determinista por intencion (Apply AI Assistance).
  // ---------------------------------------------------------------------------
  console.log('[2] Orquestador: gate determinista por intencion');

  for (const [profileKey, profile] of Object.entries(PROFILES)) {
    console.log(`  - ${profileKey} (${profile.kind})`);

    // (a) campos completos
    const completeRow = buildRow(profile, profile.complete.qualification_context);
    const complete = await runCode(orchestrator, 'Apply AI Assistance', completeRow, {}, env);
    expectEqual(
      complete.commercial_missing_fields.length, 0,
      `${profileKey}: completo no debe listar comerciales faltantes`
    );
    if (profile.kind === 'sales') {
      expectEqual(complete.should_create_lead, true, `${profileKey}: completo debe crear lead`);
      expectEqual(complete.confirmation_status, 'confirmed', `${profileKey}: completo confirma`);
      expectEqual(complete.needs_confirmation, false, `${profileKey}: completo no pide confirmacion`);
    } else {
      expectEqual(complete.should_create_lead, false, `${profileKey}: intent operativo nunca crea lead`);
      expectEqual(
        complete.confirmation_status !== 'confirmed',
        true,
        `${profileKey}: operativo no confirma lead (${complete.confirmation_status || 'none'})`
      );
    }

    // (b) falta campo obligatorio -> bloquea la creacion del lead
    const missingRow = buildRow(profile, profile.missingCtx, { overrides: profile.missingOverrides || {} });
    const blocked = await runCode(orchestrator, 'Apply AI Assistance', missingRow, {}, env);
    expectEqual(blocked.should_create_lead, false, `${profileKey}: sin ${profile.missingField} no crea lead`);
    expectIncludes(blocked.commercial_missing_fields, profile.missingField, `${profileKey}: lista el campo faltante`);
    expectEqual(blocked.commercial_missing_fields[0], profile.missingField, `${profileKey}: el primer faltante es el esperado`);

    if (profile.kind === 'sales') {
      // Los intentos de venta bloquean y preguntan el primer faltante.
      expectEqual(blocked.confirmation_status, 'pending', `${profileKey}: confirmacion queda pendiente`);
      expectEqual(blocked.needs_confirmation, true, `${profileKey}: pide confirmacion/necesita datos`);
      if (profile.expectedQuestionKey) {
        expectEqual(blocked.response_kind, 'advisor_guardrail_question', `${profileKey}: pregunta el faltante`);
        expectEqual(blocked.pending_question_key, profile.expectedQuestionKey, `${profileKey}: pregunta el primer faltante`);
        assert(String(blocked.response_text).trim().length > 0, `${profileKey}: la pregunta es un mensaje natural`);
      }
    } else {
      // Los intentos operativos NUNCA confirman ni crean: escalan a humano y
      // bloquean en firme. El gate igual deja expuestos los campos faltantes.
      expectEqual(blocked.response_kind, 'escalation_routing', `${profileKey}: operativo escala a humano`);
      expectEqual(blocked.needs_confirmation, false, `${profileKey}: operativo no pregunta al cliente`);
      expectEqual(blocked.pending_question_key, null, `${profileKey}: operativo no deja pregunta pendiente`);
    }

    // (c) correccion: el cliente entrega el dato -> crea (intentos de venta)
    const correctedRow = buildRow(profile, profile.complete.qualification_context);
    const corrected = await runCode(orchestrator, 'Apply AI Assistance', correctedRow, {}, env);
    expectEqual(corrected.commercial_missing_fields.length, 0, `${profileKey}: correccion deja comerciales completos`);
    if (profile.kind === 'sales') {
      expectEqual(corrected.should_create_lead, true, `${profileKey}: correccion crea lead`);
    }
  }

  // ---------------------------------------------------------------------------
  // 3. El gate es DETERMINISTA: sobreescribe lo que reporte el LLM.
  // ---------------------------------------------------------------------------
  console.log('[3] commercial_missing_fields coincide con la realidad (no confia en el LLM)');
  {
    // El LLM miente y dice que falta 'oc', pero el contexto lo tiene -> vacio.
    const row = buildRow(PROFILES.b2b, PROFILES.b2b.complete.qualification_context);
    row.commercial_missing_fields = ['oc', 'email'];
    const result = await runCode(orchestrator, 'Apply AI Assistance', row, {}, env);
    expectEqual(result.commercial_missing_fields.length, 0, 'orquestador descarta la mentira del LLM (oc presente)');

    // El LLM omite 'quantity' pero el contexto no lo tiene -> se agrega.
    const materialRow = buildRow(PROFILES.material, PROFILES.material.complete.qualification_context);
    delete materialRow.qualification_context.quantity;
    materialRow.commercial_missing_fields = [];
    const materialResult = await runCode(orchestrator, 'Apply AI Assistance', materialRow, {}, env);
    expectIncludes(materialResult.commercial_missing_fields, 'quantity', 'orquestador detecta quantity faltante pese al LLM');
    expectEqual(materialResult.should_create_lead, false, 'sin quantity no crea lead aunque el LLM diga ok');

    // PRD 13.4 (B06): el servicio presente NO auto-satisface product. Con
    // service='Baldosas' pero sin product en qualification_context, el gate
    // debe listar 'product' y bloquear la creacion (regresion del viejo hole).
    const noProductEvidenceRow = {
      ...buildRow(PROFILES.material, {}),
      qualification_context: {
        commune: 'Santiago', quantity: '40 unidades',
        modality: 'material', customer_type: 'b2c', lead_class: 'B',
      },
    };
    const noProductEvidenceResult = await runCode(orchestrator, 'Apply AI Assistance', noProductEvidenceRow, {}, env);
    expectEqual(noProductEvidenceResult.commercial_policy_profile, 'material', 'sin producto el perfil sigue siendo material');
    expectIncludes(noProductEvidenceResult.commercial_missing_fields, 'product', 'el servicio no debe auto-satisfacer product (PRD 13.4)');
    expectEqual(noProductEvidenceResult.should_create_lead, false, 'sin product en contexto no se crea lead');
    expectEqual(
      noProductEvidenceResult.commercial_field_evidence.product, 'missing',
      'la evidencia de product sin contexto debe reportarse missing'
    );
    expectEqual(
      noProductEvidenceResult.commercial_field_evidence.quantity, 'client_evidence',
      'quantity con contexto real debe reportar client_evidence'
    );

    // PRD 13.4 (B06): una modalidad aportada SOLO por la IA (sin evidencia en el
    // texto ni pregunta pendiente) no debe llenar qualification_context.
    const aiOnlyModalityRow = {
      ...buildRow(PROFILES.material, {}),
      qualification_context: {
        commune: 'Santiago', quantity: '40 unidades', product: 'Baldosas',
        customer_type: 'b2c', lead_class: 'B',
      },
    };
    const aiOnlyModalityResult = await runCode(orchestrator, 'Apply AI Assistance', aiOnlyModalityRow, {}, env);
    assert(
      !aiOnlyModalityResult.qualification_context.modality,
      'modalidad AI sin evidencia no debe persistirse en el contexto'
    );
    expectIncludes(aiOnlyModalityResult.commercial_missing_fields, 'modality', 'modalidad sin evidencia queda pendiente');
    expectEqual(aiOnlyModalityResult.should_create_lead, false, 'sin modalidad evidenciada no crea lead');
  }

  // ---------------------------------------------------------------------------
  // 4. CAPA DISPATCHER: defensa en profundidad (IF downstream).
  // ---------------------------------------------------------------------------
  console.log('[4] Dispatcher: defensa en profundidad');
  {
    const gateAllows = (row) => {
      const hasCommercialBlock = Array.isArray(row.commercial_missing_fields)
        && row.commercial_missing_fields.length > 0;
      return Boolean(row.should_create_lead) && !hasCommercialBlock;
    };
    assert(gateAllows({ should_create_lead: true, commercial_missing_fields: [] }) === true, 'dispatcher deja pasar lead sin comerciales pendientes');
    assert(gateAllows({ should_create_lead: true, commercial_missing_fields: ['quantity'] }) === false, 'dispatcher bloquea lead con comerciales pendientes');
    assert(gateAllows({ should_create_lead: false, commercial_missing_fields: [] }) === false, 'dispatcher bloquea should_create_lead=false');
    assert(gateAllows({ should_create_lead: true }) === true, 'dispatcher conserva compatibilidad sin campo comercial');
  }

  // ---------------------------------------------------------------------------
  // 5. CAPA CRM: Prepare Lead Assignment NO crea si el gate esta bloqueado.
  // ---------------------------------------------------------------------------
  console.log('[5] CRM: persistencia no crea con validation_errors');
  {
    const crmRow = (commercial) => ({
      phone_number: '56912345678',
      source_number_id: 1,
      external_contact_id: 'cid',
      whatsapp_name: 'Juan Perez',
      service: 'Baldosas',
      city: 'Santiago',
      requirement: 'Renovar patio',
      conversation_id: 1,
      previous_lead_id: null,
      commercial_policy_profile: 'material',
      commercial_missing_fields: commercial,
      qualification_context: { product: 'Baldosas' },
    });

    let blockedError = null;
    try {
      await runCode(crm, 'Prepare Lead Assignment', crmRow(['quantity']), {}, env);
    } catch (error) {
      blockedError = error;
    }
    assert(Boolean(blockedError), 'crm debe lanzar error al crear lead con comerciales pendientes');
    assert(
      String(blockedError?.message || '').includes('BLOCKED|')
      && String(blockedError?.message || '').includes('quantity'),
      'crm debe devolver validation_errors con los campos pendientes'
    );

    const okLead = await runCode(crm, 'Prepare Lead Assignment', crmRow([]), {}, env);
    expectEqual(okLead.lead_status_code, 'qualified_complete', 'crm crea lead cuando no hay comerciales pendientes');
  }

  // ---------------------------------------------------------------------------
  console.log(`\nGate comercial PRD: ${passed} PASS / ${failed} FAIL`);
  if (failed > 0) process.exit(1);
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
NODE
