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

  const sharedValidatorPath = 'tests/fixtures/workflow-nodes/shared/prd-validators.js';
  assert(fs.existsSync(sharedValidatorPath), 'PRD_VALIDATORS requiere una unica fuente canonica compartida');
  if (fs.existsSync(sharedValidatorPath)) {
    const canonicalValidators = fs.readFileSync(sharedValidatorPath, 'utf8').trim();
    const generatedBody = (fixturePath) => {
      const source = fs.readFileSync(fixturePath, 'utf8');
      const match = source.match(/\/\/ <generated:prd-validators>\n([\s\S]*?)\n\/\/ <\/generated:prd-validators>/);
      return match?.[1]?.trim() || '';
    };
    expectEqual(
      generatedBody('tests/fixtures/workflow-nodes/wa-conversation-orchestrator/apply-ai-assistance.js'),
      canonicalValidators,
      'Apply AI Assistance debe usar la region PRD_VALIDATORS generada'
    );
    expectEqual(
      generatedBody('tests/fixtures/workflow-nodes/wa-conversation-orchestrator/validate-ai-proposal.js'),
      canonicalValidators,
      'Validate AI Proposal debe usar la misma region PRD_VALIDATORS generada'
    );
  }

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
    // PRD 6.10 (mencion directa de producto): el producto se satisface con la
    // mencion del cliente; lo que falta es la MODALIDAD (se pregunta primero,
    // regla de orden: modalidad antes que cantidad). El cliente dice solo
    // "Baldosas" -> el gate debe pedir modality, no product.
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
      missingField: 'modality',
      missingCtx: { commune: 'Santiago', quantity: '40 unidades', customer_type: 'b2c', lead_class: 'B' },
      mentionText: 'Baldosas',
      expectedQuestionKey: 'modality',
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

  const buildRow = (profile, ctx, { confirmation = true, text, overrides = {} } = {}) => ({
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
    text_body: text ?? profile.mentionText ?? 'Si',
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
        // Regla PRD (sin pregunta circular de producto): product nunca es una
        // pregunta advisor; la mencion directa lo satisface. Si aun faltara,
        // la pregunta la formula el modelo, no el advisor.
        if (profile.expectedQuestionKey === 'product') {
          expectEqual(
            blocked.response_kind !== 'advisor_guardrail_question', true,
            `${profileKey}: product NO se pregunta por el advisor`
          );
        } else {
          expectEqual(blocked.response_kind, 'advisor_guardrail_question', `${profileKey}: pregunta el faltante`);
        }
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
      noProductEvidenceResult.pending_question_key, 'product',
      'sin producto el pending queda en product (el texto de la mencion lo formula el modelo)'
    );
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
  // 6. PRD 6.10: anti-repeticion de la pregunta comercial (clarify -> handoff).
  // El historial vive en metadata_json y el conteo solo avanza si el cliente
  // NO aporta evidencia nueva en el turno.
  // ---------------------------------------------------------------------------
  console.log('[6] Anti-repeticion: la misma pregunta sin progreso clarifica y luego escala');
  {
    const antiRepeatCtx = {
      product: 'Baldosas', commune: 'Santiago', quantity: '40 unidades',
      customer_type: 'b2c', lead_class: 'B',
    };
    const antiRepeatRow = (retry) => ({
      ...buildRow(PROFILES.material, antiRepeatCtx, { confirmation: false }),
      modality: 'unknown',
      text_body: 'No se',
      metadata_json: JSON.stringify({
        pending_question_key: 'modality',
        commercial_question_retry: retry,
      }),
      pending_question_key: 'modality',
    });
    const metadataOf = (result) => {
      try { return JSON.parse(result.metadata_json); } catch (_error) { return {}; }
    };

    // Turno 1: sin respuesta, el conteo sube a 1 y se sigue preguntando normal.
    const t1 = await runCode(orchestrator, 'Apply AI Assistance', antiRepeatRow(0), {}, env);
    expectEqual(t1.pending_question_key, 'modality', 'anti-repeat: turno 1 sigue en modality');
    expectEqual(t1.response_kind, 'advisor_guardrail_question', 'anti-repeat: turno 1 pregunta por advisor');
    expectEqual(metadataOf(t1).commercial_question_retry, 1, 'anti-repeat: turno 1 sin progreso -> retry 1');
    expectEqual(metadataOf(t1).anti_repeat_action, 'none', 'anti-repeat: retry 1 no dispara accion');

    // Turno 2: segundo turno sin progreso -> el bot aclara con voz propia.
    const t2 = await runCode(orchestrator, 'Apply AI Assistance', antiRepeatRow(1), {}, env);
    expectEqual(metadataOf(t2).commercial_question_retry, 2, 'anti-repeat: turno 2 -> retry 2');
    expectEqual(t2.response_kind, 'anti_repeat_clarify', 'anti-repeat: retry 2 clarifica con texto propio');
    expectEqual(
      metadataOf(t2).anti_repeat_action, 'clarify',
      'anti-repeat: retry 2 dispara clarify'
    );
    assert(
      String(t2.response_text).includes('no quiero insistir'),
      'anti-repeat: la clarificacion tiene voz propia del bot'
    );

    // Turno 3: tercer turno sin progreso -> escala a humano.
    const t3 = await runCode(orchestrator, 'Apply AI Assistance', antiRepeatRow(2), {}, env);
    expectEqual(t3.should_escalate, true, 'anti-repeat: retry 3 escala a humano');
    expectEqual(t3.response_kind, 'escalation_routing', 'anti-repeat: retry 3 deriva');
    expectEqual(t3.escalation_reason, 'no_progress_commercial_question_loop', 'anti-repeat: razon de escalacion explicita');
    expectEqual(t3.pending_question_key, null, 'anti-repeat: al escalar no queda pregunta pendiente');
    expectEqual(metadataOf(t3).anti_repeat_action, 'handoff', 'anti-repeat: retry 3 dispara handoff');

    // Turno 4: el cliente responde la modalidad -> el conteo se resetea.
    const t4 = await runCode(orchestrator, 'Apply AI Assistance', {
      ...antiRepeatRow(3),
      text_body: 'Solo material',
      field_updates: { modality: 'material' },
    }, {}, env);
    expectEqual(metadataOf(t4).commercial_question_retry, 0, 'anti-repeat: con avance el conteo vuelve a 0');
    expectEqual(t4.should_escalate, false, 'anti-repeat: con avance no escala');
    expectEqual(
      metadataOf(t4).anti_repeat_action, 'none',
      'anti-repeat: con avance no dispara accion'
    );
  }

  // ---------------------------------------------------------------------------
  // 7. AUTORIDAD SEMANTICA V2: la IA interpreta; policy valida y proyecta.
  // ---------------------------------------------------------------------------
  console.log('[7] Autoridad semantica v2: observaciones, evidencia y proyeccion');
  {
    const fixturePaths = {
      compile: 'tests/fixtures/workflow-nodes/wa-conversation-orchestrator/compile-turn-policy.js',
      validate: 'tests/fixtures/workflow-nodes/wa-conversation-orchestrator/validate-ai-proposal.js',
      authorize: 'tests/fixtures/workflow-nodes/wa-conversation-orchestrator/authorize-ai-turn.js',
    };
    for (const [name, fixturePath] of Object.entries(fixturePaths)) {
      assert(fs.existsSync(fixturePath), `v2 requiere fixture ${name}: ${fixturePath}`);
    }

    if (Object.values(fixturePaths).every((fixturePath) => fs.existsSync(fixturePath))) {
      const { compileTurnPolicy } = require(`${process.cwd()}/${fixturePaths.compile}`);
      const { validateAiProposal, validatePrdRules } = require(`${process.cwd()}/${fixturePaths.validate}`);
      const { authorizeAiTurn } = require(`${process.cwd()}/${fixturePaths.authorize}`);
      assert(typeof compileTurnPolicy === 'function', 'compileTurnPolicy debe ser funcion pura');
      assert(typeof validateAiProposal === 'function', 'validateAiProposal debe ser funcion pura');
      assert(typeof validatePrdRules === 'function', 'validatePrdRules compartido debe ser funcion pura');
      assert(typeof authorizeAiTurn === 'function', 'authorizeAiTurn debe ser funcion pura');
      assert(
        !fs.readFileSync(fixturePaths.validate, 'utf8').includes('FORBIDDEN_CLAIM_PATTERNS'),
        'semantic v2 no debe conservar una segunda tabla manual de claim guards'
      );

      const policyEnv = { ...env, AI_PRD_CONVERSATION_MODE: 'enforce' };
      const compile = (text, objective = 'quantity', overrides = {}) => compileTurnPolicy({
        conversation_id: 153,
        inbound_event_id: 588,
        external_message_id: 'wamid-semantic-gate',
        text_body: text,
        pending_question_key: objective,
        service: 'Placas',
        city: 'Santiago',
        requirement: 'Cotizar placas',
        qualification_context: { product: 'Placas', commune: 'Santiago' },
        commercial_missing_fields: [objective],
        ...overrides,
      }, policyEnv);
      const evidence = (text, quote, messageId = 'wamid-semantic-gate') => ({
        quote,
        start: text.indexOf(quote),
        end: text.indexOf(quote) + quote.length,
        message_id: messageId,
      });
      const proposal = (compiled, text, observations, statePatch, overrides = {}) => ({
        version: 'ai_semantic_proposal/v2',
        contract_digest: compiled.turn_policy_digest,
        reply_text: 'Entendido. ¿Confirmas los datos?',
        dialogue_action: 'confirm',
        observations,
        state_patch: statePatch,
        requested_effects: [],
        ...overrides,
      });
      const amountObservation = (text, quote, normalized, id = 'obs-amount') => ({
        id,
        concept: 'commercial_amount',
        raw_value: quote,
        normalized,
        answers_objective: 'quantity',
        evidence: evidence(text, quote),
        grounding: null,
        confidence: 0.97,
      });
      const validate = (compiled, aiProposal) => validateAiProposal({
        ...compiled,
        ai_attempt: 'initial',
        ai_proposal: aiProposal,
      });

      expectEqual(compile('6 ml').turn_policy.version, 'ai_prd_turn_policy/v2', 'policy debe usar v2');
      expectEqual(compile('6 ml').turn_policy_digest.length, 64, 'policy debe exponer digest SHA-256');
      expectIncludes(compile('6 ml').turn_policy.allowed_state_fields, 'measurements', 'policy permite measurements');
      assert(
        compile('6 ml').turn_policy.allowed_state_mappings.some((mapping) => (
          mapping.concept === 'commercial_amount' && mapping.field === 'measurements'
        )),
        'policy debe compilar mapping commercial_amount→measurements para el objetivo pendiente'
      );
      assert(
        !compile('6 ml').turn_policy.allowed_state_mappings.some((mapping) => mapping.field === 'commune'),
        'policy no debe exponer accepted facts como targets ejecutables'
      );
      assert(
        compile('6 ml').turn_policy_digest !== compile('7 ml').turn_policy_digest,
        'policy digest debe cambiar cuando cambia el mensaje inmutable'
      );
      assert(
        compile('6 ml').turn_policy.accepted_facts.some((fact) => fact.field === 'product' && fact.value === 'Placas'),
        'policy debe conservar hechos comerciales ya aceptados'
      );
      expectEqual(
        validatePrdRules('El valor es $19.990.', [], {}, {}).rule,
        'NO_INVENT_PRICE',
        'PRD_VALIDATORS conserva bloqueo legacy sin price_context oficial'
      );
      expectEqual(
        validatePrdRules('El valor es $19.990.', [], { type: 'fixed', amount: 19990 }, {}).passed,
        true,
        'PRD_VALIDATORS conserva autorizacion legacy con price_context oficial'
      );

      for (const [text, quote, normalized, field, expectedValue] of [
        ['6 ml', '6 ml', { kind: 'length', value: 6, unit: 'linear_meter' }, 'measurements', '6 ml'],
        ['son 6ml', '6ml', { kind: 'length', value: 6, unit: 'linear_meter' }, 'measurements', '6ml'],
        ['6 metros lineales', '6 metros lineales', { kind: 'length', value: 6, unit: 'linear_meter' }, 'measurements', '6 metros lineales'],
        ['40 unidades', '40 unidades', { kind: 'count', value: 40, unit: 'unit' }, 'quantity', '40 unidades'],
      ]) {
        const compiled = compile(text);
        const observation = amountObservation(text, quote, normalized);
        const validation = validate(compiled, proposal(compiled, text, [observation], [{ field, observation_id: observation.id }]));
        expectEqual(validation.valid, true, `${text}: comprension AI evidenciada debe validarse`);
        expectEqual(validation.authorized_state_patch[0].field, field, `${text}: mapping autorizado`);
        const authorized = authorizeAiTurn({ ...compiled, ai_proposal: proposal(compiled, text, [observation], [{ field, observation_id: observation.id }]), ai_validation: validation });
        expectEqual(authorized.qualification_context[field], expectedValue, `${text}: compatibilidad persiste valor crudo`);
      }

      const multiText = '6 ml en Santiago, solo material';
      const multiCompiled = compile(multiText, 'quantity', {
        qualification_context: { product: 'Placas' },
        commercial_missing_fields: ['quantity', 'commune', 'modality'],
      });
      const multiObservations = [
        amountObservation(multiText, '6 ml', { kind: 'length', value: 6, unit: 'linear_meter' }),
        { id: 'obs-commune', concept: 'commune', raw_value: 'Santiago', normalized: 'Santiago', answers_objective: null, evidence: evidence(multiText, 'Santiago'), grounding: null, confidence: 0.96 },
        { id: 'obs-modality', concept: 'modality', raw_value: 'solo material', normalized: 'material', answers_objective: null, evidence: evidence(multiText, 'solo material'), grounding: { kind: 'modality_synonym', id: 'material:solo-material' }, confidence: 0.96 },
      ];
      const multiPatch = [
        { field: 'measurements', observation_id: 'obs-amount' },
        { field: 'commune', observation_id: 'obs-commune' },
        { field: 'modality', observation_id: 'obs-modality' },
      ];
      const multiValidation = validate(multiCompiled, proposal(multiCompiled, multiText, multiObservations, multiPatch));
      expectEqual(multiValidation.valid, true, 'un mensaje puede aportar multiples hechos evidenciados');
      expectEqual(multiValidation.authorized_state_patch.length, 3, 'todos los mappings validos progresan juntos');

      const unknownText = 'La entrada es por un pasaje interior';
      const unknownCompiled = compile(unknownText, 'quantity');
      const unknownObservation = {
        id: 'obs-access-note', concept: 'site_access_note', raw_value: unknownText,
        normalized: null, answers_objective: null, evidence: evidence(unknownText, unknownText),
        grounding: null, confidence: 0.9,
      };
      const unknownValidation = validate(unknownCompiled, proposal(
        unknownCompiled, unknownText, [unknownObservation], [], { dialogue_action: 'ask_clarification' }
      ));
      expectEqual(unknownValidation.valid, true, 'concepto extensible puede guiar dialogo sin persistencia');
      expectEqual(unknownValidation.authorized_state_patch.length, 0, 'concepto extensible no autoriza estado');

      const ambiguousText = 'Necesito MINVU';
      const ambiguousCompiled = compile(ambiguousText, 'product', {
        qualification_context: { commune: 'Santiago' },
        commercial_missing_fields: ['product'],
        commercial_context: { catalog_items: [
          { id: 12, sku: 'minvu-0', name: 'Baldosa MINVU 0', service_keywords: ['MINVU'], is_active: true },
          { id: 13, sku: 'minvu-1', name: 'Baldosa MINVU 1', service_keywords: ['MINVU'], is_active: true },
        ] },
      });
      const ambiguousObservation = {
        id: 'obs-product', concept: 'product', raw_value: 'MINVU',
        normalized: { kind: 'unknown', candidates: ['minvu-0', 'minvu-1'] },
        answers_objective: 'product', evidence: evidence(ambiguousText, 'MINVU'),
        grounding: null, confidence: 0.7,
      };
      const ambiguousValidation = validate(ambiguousCompiled, proposal(
        ambiguousCompiled, ambiguousText, [ambiguousObservation], [], { dialogue_action: 'ask_clarification' }
      ));
      expectEqual(ambiguousValidation.valid, true, 'ambiguedad explicita permite aclaracion contextual');
      expectEqual(ambiguousValidation.authorized_state_patch.length, 0, 'ambiguedad no persiste producto');

      const invalidText = '6 ml';
      const invalidCompiled = compile(invalidText);
      const invalidObservation = amountObservation(invalidText, '6 ml', { kind: 'length', value: 6, unit: 'linear_meter' });
      const invalidOffset = validate(invalidCompiled, proposal(invalidCompiled, invalidText, [{
        ...invalidObservation, evidence: { ...invalidObservation.evidence, start: 1 },
      }], [{ field: 'measurements', observation_id: invalidObservation.id }]));
      assert(invalidOffset.rule_errors.some((error) => error.code === 'invalid_evidence_offsets'), 'offset invalido debe rechazarse');
      const missingReference = validate(invalidCompiled, proposal(invalidCompiled, invalidText, [invalidObservation], [{ field: 'measurements', observation_id: 'missing' }]));
      assert(missingReference.rule_errors.some((error) => error.code === 'observation_reference_not_found'), 'state_patch exige observacion existente');
      const forbiddenField = validate(invalidCompiled, proposal(invalidCompiled, invalidText, [invalidObservation], [{ field: 'price', observation_id: invalidObservation.id }]));
      assert(forbiddenField.rule_errors.some((error) => error.code === 'state_field_not_allowed'), 'campo no allowlisted debe rechazarse');

      const crossFieldCompiled = compile('6 ml', 'quantity', {
        city: '',
        qualification_context: { product: 'Placas' },
        commercial_missing_fields: ['quantity', 'commune'],
      });
      const crossFieldAmount = amountObservation('6 ml', '6 ml', { kind: 'length', value: 6, unit: 'linear_meter' });
      const amountAsCommune = validate(crossFieldCompiled, proposal(
        crossFieldCompiled,
        '6 ml',
        [crossFieldAmount],
        [{ field: 'commune', observation_id: crossFieldAmount.id }]
      ));
      assert(
        amountAsCommune.rule_errors.some((error) => error.code === 'state_mapping_not_allowed'),
        'commercial_amount no puede autorizar commune aunque ambos campos esten pendientes'
      );
      const forgedCrossFieldProposal = proposal(
        crossFieldCompiled,
        '6 ml',
        [crossFieldAmount],
        [{ field: 'commune', observation_id: crossFieldAmount.id }]
      );
      const forgedCrossFieldAuthorization = authorizeAiTurn({
        ...crossFieldCompiled,
        ai_proposal: forgedCrossFieldProposal,
        ai_validation: {
          valid: true,
          accepted_observations: [crossFieldAmount],
          authorized_state_patch: [{ field: 'commune', observation_id: crossFieldAmount.id }],
          authorized_effects: [],
        },
      });
      expectEqual(
        forgedCrossFieldAuthorization.qualification_context.commune,
        undefined,
        'authorizer aplica defensa en profundidad a concept→field aunque reciba validation forjada'
      );

      const overwriteText = 'Ahora en Valparaíso';
      const overwriteCompiled = compile(overwriteText);
      const overwriteObservation = {
        id: 'obs-overwrite-commune', concept: 'commune', raw_value: 'Valparaíso',
        normalized: 'Valparaíso', answers_objective: null,
        evidence: evidence(overwriteText, 'Valparaíso'), grounding: null, confidence: 0.98,
      };
      const overwriteValidation = validate(overwriteCompiled, proposal(
        overwriteCompiled,
        overwriteText,
        [overwriteObservation],
        [{ field: 'commune', observation_id: overwriteObservation.id }]
      ));
      assert(
        overwriteValidation.rule_errors.some((error) => error.code === 'accepted_fact_immutable'),
        'un state_patch no puede sobrescribir un hecho aceptado del turno'
      );
      const forgedOverwriteProposal = proposal(
        overwriteCompiled,
        overwriteText,
        [overwriteObservation],
        [{ field: 'commune', observation_id: overwriteObservation.id }]
      );
      const forgedOverwriteAuthorization = authorizeAiTurn({
        ...overwriteCompiled,
        ai_proposal: forgedOverwriteProposal,
        ai_validation: {
          valid: true,
          accepted_observations: [overwriteObservation],
          authorized_state_patch: [{ field: 'commune', observation_id: overwriteObservation.id }],
          authorized_effects: [],
        },
      });
      expectEqual(
        forgedOverwriteAuthorization.qualification_context.commune,
        'Santiago',
        'authorizer aplica defensa en profundidad y preserva accepted facts aunque reciba validation forjada'
      );

      const mismatchText = 'Santiago';
      const mismatchCompiled = compile(mismatchText, 'quantity', {
        city: '',
        qualification_context: { product: 'Placas' },
        commercial_missing_fields: ['quantity', 'commune'],
      });
      const communeObservation = {
        id: 'obs-mismatch-commune', concept: 'commune', raw_value: 'Santiago',
        normalized: 'Santiago', answers_objective: 'commune',
        evidence: evidence(mismatchText, 'Santiago'), grounding: null, confidence: 0.98,
      };
      const communeAsAmount = validate(mismatchCompiled, proposal(
        mismatchCompiled,
        mismatchText,
        [communeObservation],
        [{ field: 'measurements', observation_id: communeObservation.id }]
      ));
      assert(
        communeAsAmount.rule_errors.some((error) => error.code === 'state_mapping_not_allowed'),
        'un concepto commune no puede autorizar un campo de commercial_amount'
      );

      const stockClaim = validate(invalidCompiled, proposal(
        invalidCompiled,
        invalidText,
        [invalidObservation],
        [{ field: 'measurements', observation_id: invalidObservation.id }],
        { reply_text: 'Sí, tenemos stock disponible.' }
      ));
      assert(
        stockClaim.rule_errors.some((error) => error.code === 'forbidden_claim' && error.detail === 'NO_CONFIRM_STOCK'),
        'reply_text no puede confirmar stock cuando la policy lo prohibe'
      );

      for (const [ruleId, replyText] of [
        ['NO_INVENT_PRICE', 'El precio es $12.990.'],
        ['NO_CONFIRM_PAYMENT', 'Tu pago fue confirmado.'],
        ['NO_DISCOUNT', 'Te ofrezco un descuento del 10%.'],
        ['NO_PROMISE_DELIVERY', 'Te llegará mañana.'],
        ['NO_PROMISE_INSTALLATION', 'Instalaremos las placas.'],
      ]) {
        const forbiddenReply = validate(invalidCompiled, proposal(
          invalidCompiled,
          invalidText,
          [invalidObservation],
          [{ field: 'measurements', observation_id: invalidObservation.id }],
          { reply_text: replyText }
        ));
        assert(
          forbiddenReply.rule_errors.some((entry) => entry.code === 'forbidden_claim' && entry.detail === ruleId),
          `${ruleId}: forbidden_rule_ids debe activar una guarda deterministica de salida`
        );
      }

      for (const [ruleId, replyText] of [
        ['NO_CONFIRM_STOCK', 'Hay disponibilidad de placas.'],
        ['NO_CONFIRM_PAYMENT', 'Ya puedes retirar.'],
        ['NO_DISCOUNT', 'Tenemos descuento.'],
        ['NO_PROMISE_DELIVERY', 'Despacho el viernes.'],
        ['NO_PROMISE_INSTALLATION', 'La instalación es gratis.'],
      ]) {
        const canonicalForbiddenReply = validate(invalidCompiled, proposal(
          invalidCompiled,
          invalidText,
          [invalidObservation],
          [{ field: 'measurements', observation_id: invalidObservation.id }],
          { reply_text: replyText }
        ));
        assert(
          canonicalForbiddenReply.rule_errors.some((entry) => entry.code === 'forbidden_claim' && entry.detail === ruleId),
          `${ruleId}: semantic v2 debe preservar el vector canonico PRD`
        );
      }

      for (const replyText of [
        'Necesito verificar el despacho del viernes antes de confirmarte.',
        'La instalación es una opción sujeta a cotizar.',
      ]) {
        const prudentReply = validate(invalidCompiled, proposal(
          invalidCompiled,
          invalidText,
          [invalidObservation],
          [{ field: 'measurements', observation_id: invalidObservation.id }],
          { reply_text: replyText }
        ));
        expectEqual(prudentReply.valid, true, `respuesta prudente no debe bloquearse: ${replyText}`);
      }

      const customerStockText = '¿Tienen stock?';
      const customerStockCompiled = compile(customerStockText, 'none', { commercial_missing_fields: [] });
      const safeStockReply = validate(customerStockCompiled, proposal(
        customerStockCompiled,
        customerStockText,
        [],
        [],
        { reply_text: 'Voy a verificar disponibilidad antes de confirmarte.' }
      ));
      expectEqual(
        safeStockReply.valid,
        true,
        'la guarda de claims solo inspecciona salida generada y no interpreta el mensaje del cliente'
      );

      const filteredPolicy = {
        ...invalidCompiled.turn_policy,
        forbidden_rule_ids: ['NO_CONFIRM_STOCK'],
      };
      const filteredDiscountReply = validateAiProposal({
        ...invalidCompiled,
        turn_policy: filteredPolicy,
        ai_proposal: proposal(
          invalidCompiled,
          invalidText,
          [invalidObservation],
          [{ field: 'measurements', observation_id: invalidObservation.id }],
          { reply_text: 'Tenemos descuento.' }
        ),
      });
      expectEqual(
        filteredDiscountReply.valid,
        true,
        'semantic v2 solo ejecuta los forbidden_rule_ids seleccionados por la policy'
      );

      const utf8Text = 'Ñuñoa: 6 ml';
      const utf8Compiled = compile(utf8Text);
      const utf8Start = Buffer.byteLength('Ñuñoa: ', 'utf8');
      const utf8Observation = {
        ...amountObservation(utf8Text, '6 ml', { kind: 'length', value: 6, unit: 'linear_meter' }),
        evidence: { quote: '6 ml', start: utf8Start, end: utf8Start + 4, message_id: 'wamid-semantic-gate' },
      };
      expectEqual(
        validate(utf8Compiled, proposal(utf8Compiled, utf8Text, [utf8Observation], [{ field: 'measurements', observation_id: utf8Observation.id }])).valid,
        true,
        'evidencia debe validar offsets UTF-8 en bytes y no indices UTF-16'
      );
    }
  }

  // ---------------------------------------------------------------------------
  console.log(`\nGate comercial PRD: ${passed} PASS / ${failed} FAIL`);
  if (failed > 0) process.exit(1);
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
NODE
