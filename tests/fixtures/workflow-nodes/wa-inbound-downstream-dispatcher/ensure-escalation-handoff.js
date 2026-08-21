// =============================================================================
// Ensure Escalation Handoff — Unidad 3: escalamiento humano durable (P0).
// -----------------------------------------------------------------------------
// Nodo del dispatcher "WA - Inbound Downstream Dispatcher". SOURCE OF TRUTH
// del routing motivo->area->prioridad->responsable (PRD #22/#23/#9.5/#11) y
// del gate de no-cierre de intenciones operativas (PRD #22.16/#31.7).
//
// El mismo archivo es, en pruebas (harness), un modulo Node: expone
// HANDOFF_ROUTING, routeEscalation, evaluateClosureGate y buildIdempotencyKey
// para los tests de contrato. En n8n (Code node) solo se ejecuta la seccion
// final que lee `items`. Single source of truth: el fixture se reinyecta al
// workflow con tests/scripts/sync-workflow-nodes.mjs.
//
// Idempotency key: `{conversation_id}:{motivo}:{trigger}` — el trigger es el
// motivo textual normalizado (o 'intent:<codigo>'), de modo que un replay del
// mismo evento no duplica y un motivo distinto abre un handoff propio.
//
// Precedencia de routing (memoria #679):
// opt-out/abandono → humano → escalación/terminal → operacional → re-engagement → comercial/IA
// =============================================================================

const HANDOFF_ROUTING = {
  // PRECEDENCIA 1: opt-out/abandono
  opt_out: { area: 'claims', area_label: 'Reclamos', prioridad: 'urgente', responsable: 'Responsable de Reclamos' },
  abandoned: { area: 'sales', area_label: 'Ventas', prioridad: 'media', responsable: 'Ejecutiva comercial' },

  // PRECEDENCIA 2: humano (solicitud explícita de persona)
  talk_human: { area: 'sales', area_label: 'Ventas', prioridad: 'alta', responsable: 'Ejecutiva comercial' },

  // PRECEDENCIA 3: escalación/terminal
  frustration: { area: 'sales', area_label: 'Ventas', prioridad: 'alta', responsable: 'Ejecutiva comercial' },
  high_urgency: { area: 'sales', area_label: 'Ventas', prioridad: 'alta', responsable: 'Ejecutiva comercial' },
  large_project: { area: 'sales', area_label: 'Ventas', prioridad: 'alta', responsable: 'Ejecutiva comercial' },
  complex_installation: { area: 'sales', area_label: 'Ventas', prioridad: 'alta', responsable: 'Ejecutiva comercial' },
  complaint: { area: 'claims', area_label: 'Reclamos', prioridad: 'urgente', responsable: 'Responsable de Reclamos' },
  discount: { area: 'management', area_label: 'Gerencia', prioridad: 'alta', responsable: 'Gerencia' },
  special_payment_condition: { area: 'management', area_label: 'Gerencia', prioridad: 'alta', responsable: 'Gerencia' },

  // PRECEDENCIA 4: operacional
  scheduling_change: { area: 'scheduling', area_label: 'Programación', prioridad: 'media', responsable: 'Programación (despacho/instalación)' },
  committed_issue: { area: 'scheduling', area_label: 'Programación', prioridad: 'alta', responsable: 'Programación (despacho/instalación)' },
  stock_confirm: { area: 'sales', area_label: 'Ventas', prioridad: 'media', responsable: 'Ejecutiva comercial' },
  photos_eval: { area: 'sales', area_label: 'Ventas', prioridad: 'media', responsable: 'Ejecutiva comercial' },
  payment_proof: { area: 'finance', area_label: 'Finanzas', prioridad: 'alta', responsable: 'Finanzas' },
  invoice: { area: 'finance', area_label: 'Finanzas', prioridad: 'media', responsable: 'Finanzas / Administración' },
  warranty: { area: 'post_sale', area_label: 'Postventa', prioridad: 'alta', responsable: 'Administración / Postventa' },
  post_sale: { area: 'post_sale', area_label: 'Postventa', prioridad: 'media', responsable: 'Administración / Postventa' },

  // PRECEDENCIA 5: re-engagement
  loop: { area: 'sales', area_label: 'Ventas', prioridad: 'media', responsable: 'Ejecutiva comercial' },
  reengagement: { area: 'sales', area_label: 'Ventas', prioridad: 'media', responsable: 'Ejecutiva comercial' },

  // PRECEDENCIA 6: comercial/IA (B2B)
  b2b: { area: 'b2b', area_label: 'B2B', prioridad: 'alta', responsable: 'Patricia / Área B2B' },
  purchase_order: { area: 'b2b', area_label: 'B2B', prioridad: 'alta', responsable: 'Patricia / Área B2B' },
};

// Fallback determinista por area declarada por la AI (contrato del advisor).
const AREA_FALLBACK = {
  sales: { area: 'sales', area_label: 'Ventas', prioridad: 'alta', responsable: 'Ejecutiva comercial' },
  b2b: { area: 'b2b', area_label: 'B2B', prioridad: 'alta', responsable: 'Patricia / Área B2B' },
  finance: { area: 'finance', area_label: 'Finanzas', prioridad: 'alta', responsable: 'Finanzas' },
  post_sale: { area: 'post_sale', area_label: 'Postventa', prioridad: 'media', responsable: 'Administración / Postventa' },
  claims: { area: 'claims', area_label: 'Reclamos', prioridad: 'urgente', responsable: 'Responsable de Reclamos' },
  scheduling: { area: 'scheduling', area_label: 'Programación', prioridad: 'media', responsable: 'Programación (despacho/instalación)' },
  management: { area: 'management', area_label: 'Gerencia', prioridad: 'alta', responsable: 'Gerencia' },
};

const DEFAULT_ROUTING = { area: 'sales', area_label: 'Ventas', prioridad: 'media', responsable: 'Ejecutiva comercial' };

const INTENT_TO_MOTIVE = {
  talk_to_human: 'talk_human',
  complaint: 'complaint',
  warranty_inquiry: 'warranty',
  payment_proof: 'payment_proof',
  invoice_request: 'invoice',
  b2b_request: 'b2b',
  purchase_order: 'purchase_order',
  discount_request: 'discount',
  reschedule_delivery: 'scheduling_change',
  reschedule_installation: 'scheduling_change',
  post_sale: 'post_sale',
  stock_inquiry: 'stock_confirm',
  returning_customer: 'loop',
  review: 'loop',
  opt_out: 'opt_out',           // PRECEDENCIA 1
  abandoned_conversation: 'abandoned', // PRECEDENCIA 1
  frustration_detected: 'frustration', // PRECEDENCIA 3
  loop_detected: 'loop',        // PRECEDENCIA 5
  reengagement_detected: 'reengagement', // PRECEDENCIA 5
};

// Motivo por señales de texto del reason de escalamiento (PRD #22 triggers).
// Ordenado por PRECEDENCIA (primero = mayor precedencia)
const REASON_TO_MOTIVE = [
  // PRECEDENCIA 1: opt-out/abandono
  ['opt_out', /no me escribas|escribas mas|dame de baja|baja.*(pas|mensajes|programa)|\bstop\b|no quiero.*mensajes|dej.*escribirme|no me envies|darme de baja|quitarme|no me molestes|opt.?out/i],
  ['abandoned', /ya no (me )?(interesa|necesito|quiero)|lo pense|estoy con (la )?(otra|competencia)|no voy a (comprar|avanzar)|cerremos/i],

  // PRECEDENCIA 2: humano
  ['talk_human', /hablar.*(persona|humano|ejecutiva|operador)|atencion humana|persona real|\bejecutiv\b|\boperador\b|\basesor\b|necesito (una|un) (ejecutiva|asesor|humano|operador|persona)/i],

  // PRECEDENCIA 3: escalación/terminal
  ['complaint', /reclamo|queja|molest|frustr|mala atencion|falla|roto|quebr|problema/i],
  ['frustration', /no me (estai|está|estas|estás|escuchas|entiendes)|no (escuchai|escucha|entendi)|que (lata|fome)|pesimo|mal servicio|no (sirve|funciona|gusta)|decepcionado|ayuda|no entiendo|que (hay|hace) (falta|que hacer)|quejarme|problema contigo/i],
  ['high_urgency', /urgent|para ayer|necesito (ya|ahora|urgente)/i],
  ['large_project', /2\.000\.000|dos millones|millon/i],
  ['complex_installation', /instalacion|coordinacion logistica|acceso/i],
  ['discount', /descuento|igualar|bajo el precio|rebaja/i],
  ['special_payment_condition', /condicion (especial|servicio de pago|pago a 30)/i],

  // PRECEDENCIA 4: operacional
  ['warranty', /garant/i],
  ['payment_proof', /comprobante|transferencia|abono|pago|pago enviado/i],
  ['invoice', /factur/i],
  ['scheduling_change', /reagend|cambio de fecha|fecha/i],
  ['committed_issue', /despacho|programada|programado|pedido comprometido/i],
  ['stock_confirm', /stock|disponibilidad/i],
  ['photos_eval', /foto|fotos|imagen/i],

  // PRECEDENCIA 5: re-engagement
  ['loop', /(no me (estai|está|estas|estás)|no (escuchai|escucha|entendi|entiendes)).*(repet|otra vez|de nuevo)|(repet|otra vez|de nuevo).*(no me|no escucha|no entendi)/i],
  ['reengagement', /hola de nuevo|volvi|volví|retomar|seguir.*anterior|la anterior|misma solicitud|misma cotizacion/i],

  // PRECEDENCIA 6: comercial/IA (B2B)
  ['b2b', /b2b|empresa|constructora|inmobiliaria|licitacion|proveedor|volumen/i],
  ['purchase_order', /orden de compra|\boc\b/i],
];

const normalizeReason = (value) => String(value ?? '').trim().replace(/\s+/g, ' ').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

const motiveFromReason = (reason) => {
  const text = normalizeReason(reason);
  if (!text) return null;
  for (const [motive, pattern] of REASON_TO_MOTIVE) {
    if (pattern.test(text)) return motive;
  }
  return null;
};

// =============================================================================
// Precedence resolver: dado un conjunto de motivos candidatos, devuelve el de
// mayor precedencia según el orden: opt-out/abandono → humano → escalación/terminal
// → operacional → re-engagement → comercial/IA
// =============================================================================
const PRECEDENCE_ORDER = [
  'opt_out',
  'abandoned',
  'talk_human',
  'complaint',
  'frustration',
  'high_urgency',
  'large_project',
  'complex_installation',
  'discount',
  'special_payment_condition',
  'warranty',
  'payment_proof',
  'invoice',
  'scheduling_change',
  'committed_issue',
  'stock_confirm',
  'photos_eval',
  'post_sale',
  'loop',
  'reengagement',
  'b2b',
  'purchase_order',
];

const resolvePrecedence = (motives) => {
  if (!motives || motives.length === 0) return null;
  for (const motive of PRECEDENCE_ORDER) {
    if (motives.includes(motive)) return motive;
  }
  return motives[0]; // fallback to first if not in precedence list
};

const routeEscalation = (row) => {
  const conversationId = Number(row.conversation_id);
  const hasConversation = Number.isSafeInteger(conversationId) && conversationId > 0;
  const phoneNumber = String(row.phone_number || '').trim();
  const shouldEscalate = Boolean(row.should_escalate) || Boolean(row.escalation_required);
  const area = String(row.escalation_area || '').trim();
  const aiRequestsOperational = Boolean(area && area !== 'none' && area !== 'sales');
  const escalated = shouldEscalate || aiRequestsOperational;

  if (!escalated || !hasConversation || !phoneNumber) {
    return {
      escalated: false,
      write: false,
      motivo: null,
      routing: null,
      idempotency_key: null,
      trigger: null,
      precedence_level: null,
      all_candidate_motives: [],
    };
  }

  const intent = String(row.intent || '').trim();
  const rawReason = String(row.escalation_reason || '').trim();
  const customerText = String(row.text_body || '').trim();
  const normalizedText = customerText.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const isReengagement = Boolean(row.is_reengagement);
  const hasPendingFollowups = Boolean(row.has_pending_followups);

  // Collect ALL candidate motives from different sources
  const candidateMotives = new Set();

  // 1. From raw reason text (highest signal)
  const reasonMotive = motiveFromReason(rawReason);
  if (reasonMotive) candidateMotives.add(reasonMotive);

  // 2. From AI intent
  const intentMotive = INTENT_TO_MOTIVE[intent];
  if (intentMotive) candidateMotives.add(intentMotive);

  // 3. From AI declared area
  if (area && area !== 'none') candidateMotives.add(area);

  // 4. From conversation context: re-engagement
  if (isReengagement) {
    if (hasPendingFollowups) candidateMotives.add('reengagement');
    else candidateMotives.add('loop');
  }

  // 5. From frustration/loop detection in conversation orchestrator
  if (row.escalation_reason === 'frustration_detected') candidateMotives.add('frustration');
  if (row.escalation_reason === 'loop_detected') candidateMotives.add('loop');

  // 6. From opt-out/abandoned detection
  const optOutPatterns = [/no me escribas|escribas mas|dame de baja|baja.*(pas|mensajes|programa)|\bstop\b|no quiero.*mensajes|dej.*escribirme|no me envies|darme de baja|quitarme|no me molestes|opt.?out/i];
  const abandonedPatterns = [/ya no (interesa|necesito|quiero)|lo pense|estoy con (otra|competencia)|no voy a (comprar|avanzar)|cerremos/i];
  if (optOutPatterns.some(p => p.test(normalizedText))) candidateMotives.add('opt_out');
  if (abandonedPatterns.some(p => p.test(normalizedText))) candidateMotives.add('abandoned');

  // Resolve to highest precedence motive
  const allCandidates = Array.from(candidateMotives);
  const resolvedMotive = resolvePrecedence(allCandidates);

  const routing = HANDOFF_ROUTING[resolvedMotive] || AREA_FALLBACK[area] || DEFAULT_ROUTING;
  const trigger = rawReason || (intent ? `intent:${intent}` : routing.area);

  // Determine precedence level for logging
  const precedenceLevel = PRECEDENCE_ORDER.indexOf(resolvedMotive) + 1;

  return {
    escalated: true,
    write: true,
    motivo: resolvedMotive || routing.area,
    routing,
    trigger,
    idempotency_key: buildIdempotencyKey(conversationId, resolvedMotive || routing.area, trigger),
    precedence_level: precedenceLevel,
    all_candidate_motives: allCandidates,
  };
};

const buildIdempotencyKey = (conversationId, motivo, trigger) =>
  [conversationId, motivo, trigger].join(':');

// =============================================================================
// Gate de no-cierre (PRD #33.16, #33.8): ninguna intencion operativa
// (reclamo, garantia, comprobante, factura) ni B2B se cierra mientras el
// escalamiento no exista y este al menos 'notified'.
// =============================================================================
const OPERATIONAL_CLOSURE_INTENTS = new Set([
  'complaint',
  'warranty_inquiry',
  'payment_proof',
  'invoice_request',
  'b2b_request',
  'purchase_order',
]);

const NOTIFIED_OR_BETTER = new Set(['notified', 'acknowledged', 'resolved']);

const evaluateClosureGate = (input) => {
  const intent = String(input.intent || '').trim();
  const shouldEscalate = Boolean(input.should_escalate || input.escalation_required);
  const customerType = String(input.customer_type || '').trim();
  const leadClass = String(input.lead_class || '').trim();
  const operational = OPERATIONAL_CLOSURE_INTENTS.has(intent)
    || customerType === 'b2b'
    || leadClass === 'D';

  if (!operational || !shouldEscalate) {
    return {
      operational,
      requires_handoff: false,
      closure_allowed: true,
      required_status: null,
      reason: 'no_handoff_required',
      handoff_exists: false,
    };
  }

  const handoffExists = Boolean(input.handoff_exists);
  const handoffStatus = String(input.handoff_status || '').trim();
  if (!handoffExists) {
    return {
      operational,
      requires_handoff: true,
      closure_allowed: false,
      required_status: 'notified',
      reason: 'handoff_missing',
      handoff_exists: false,
    };
  }

  const ready = NOTIFIED_OR_BETTER.has(handoffStatus);
  return {
    operational,
    requires_handoff: true,
    closure_allowed: ready,
    required_status: 'notified',
    reason: ready ? 'handoff_notified' : 'handoff_pending',
    handoff_exists: true,
    handoff_status: handoffStatus,
  };
};

// =============================================================================
// Seccion n8n (Code node): procesa el item de entrada del dispatcher.
// En Node (harness) `items` no existe y este bloque no se ejecuta.
// =============================================================================
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    HANDOFF_ROUTING,
    AREA_FALLBACK,
    DEFAULT_ROUTING,
    motiveFromReason,
    routeEscalation,
    buildIdempotencyKey,
    evaluateClosureGate,
    OPERATIONAL_CLOSURE_INTENTS,
    PRECEDENCE_ORDER,
    resolvePrecedence,
    REASON_TO_MOTIVE,
    INTENT_TO_MOTIVE,
  };
}

if (typeof items !== 'undefined') {
  const row = items[0]?.json ?? {};
  const resolution = routeEscalation(row);
  const gate = evaluateClosureGate({
    intent: row.intent,
    should_escalate: resolution.escalated,
    customer_type: row.customer_type,
    lead_class: row.lead_class,
    handoff_exists: row.declared_handoff_exists === true && resolution.escalated,
    handoff_status: row.declared_handoff_status || row.handoff_status || 'pending',
  });

  return [
    {
      json: {
        ...row,
        handoff_write: resolution.write,
        handoff_skipped: !resolution.write,
        handoff_scope: {
          conversation_id: Number(row.conversation_id) > 0 ? Number(row.conversation_id) : null,
          phone_number: String(row.phone_number || '').trim() || null,
          source_number_id: Number(row.source_number_id) > 0 ? Number(row.source_number_id) : null,
          inbound_event_id: Number(row.inbound_event_id) > 0 ? Number(row.inbound_event_id) : null,
          motivo: resolution.motivo,
          area: resolution.routing?.area ?? null,
          area_label: resolution.routing?.area_label ?? null,
          prioridad: resolution.routing?.prioridad ?? null,
          responsable: resolution.routing?.responsable ?? null,
          idempotency_key: resolution.idempotency_key,
          trigger: resolution.trigger,
          escalation_reason: String(row.escalation_reason || '').trim() || null,
          escalation_area: String(row.escalation_area || '').trim() || null,
          intent: String(row.intent || '').trim() || null,
          estado: 'pending',
        },
        handoff_gate: gate,
        // Structured logging for precedence resolution (memoria #679)
        handoff_precedence_level: resolution.precedence_level,
        handoff_candidate_motives: resolution.all_candidate_motives,
        handoff_resolved_motive: resolution.motivo,
      },
    },
  ];
}