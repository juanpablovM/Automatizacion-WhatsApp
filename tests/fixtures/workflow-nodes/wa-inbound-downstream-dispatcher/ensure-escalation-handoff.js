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
// =============================================================================

const HANDOFF_ROUTING = {
  talk_human: { area: 'sales', area_label: 'Ventas', prioridad: 'alta', responsable: 'Ejecutiva comercial' },
  frustration: { area: 'sales', area_label: 'Ventas', prioridad: 'alta', responsable: 'Ejecutiva comercial' },
  high_urgency: { area: 'sales', area_label: 'Ventas', prioridad: 'alta', responsable: 'Ejecutiva comercial' },
  large_project: { area: 'sales', area_label: 'Ventas', prioridad: 'alta', responsable: 'Ejecutiva comercial' },
  complex_installation: { area: 'sales', area_label: 'Ventas', prioridad: 'alta', responsable: 'Ejecutiva comercial' },
  stock_confirm: { area: 'sales', area_label: 'Ventas', prioridad: 'media', responsable: 'Ejecutiva comercial' },
  photos_eval: { area: 'sales', area_label: 'Ventas', prioridad: 'media', responsable: 'Ejecutiva comercial' },
  loop: { area: 'sales', area_label: 'Ventas', prioridad: 'media', responsable: 'Ejecutiva comercial' },
  b2b: { area: 'b2b', area_label: 'B2B', prioridad: 'alta', responsable: 'Patricia / Área B2B' },
  purchase_order: { area: 'b2b', area_label: 'B2B', prioridad: 'alta', responsable: 'Patricia / Área B2B' },
  payment_proof: { area: 'finance', area_label: 'Finanzas', prioridad: 'alta', responsable: 'Finanzas' },
  invoice: { area: 'finance', area_label: 'Finanzas', prioridad: 'media', responsable: 'Finanzas / Administración' },
  warranty: { area: 'post_sale', area_label: 'Postventa', prioridad: 'alta', responsable: 'Administración / Postventa' },
  post_sale: { area: 'post_sale', area_label: 'Postventa', prioridad: 'media', responsable: 'Administración / Postventa' },
  complaint: { area: 'claims', area_label: 'Reclamos', prioridad: 'urgente', responsable: 'Responsable de Reclamos' },
  scheduling_change: { area: 'scheduling', area_label: 'Programación', prioridad: 'media', responsable: 'Programación (despacho/instalación)' },
  committed_issue: { area: 'scheduling', area_label: 'Programación', prioridad: 'alta', responsable: 'Programación (despacho/instalación)' },
  discount: { area: 'management', area_label: 'Gerencia', prioridad: 'alta', responsable: 'Gerencia' },
  special_payment_condition: { area: 'management', area_label: 'Gerencia', prioridad: 'alta', responsable: 'Gerencia' },
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
};

// Motivo por señales de texto del reason de escalamiento (PRD #22 triggers).
const REASON_TO_MOTIVE = [
  ['complaint', /reclamo|queja|molest|frustr|mala atencion|falla|roto|quebr|problema/i],
  ['warranty', /garant/i],
  ['payment_proof', /comprobante|transferencia|abono|pago|pago enviado/i],
  ['invoice', /factur/i],
  ['b2b', /b2b|empresa|constructora|inmobiliaria|licitacion|orden de compra|proveedor|volumen/i],
  ['discount', /descuento|igualar|bajo el precio|rebaja/i],
  ['special_payment_condition', /condicion (especial|servicio de pago|pago a 30)/i],
  ['large_project', /2\.000\.000|dos millones|millon/i],
  ['high_urgency', /urgent/i],
  ['scheduling_change', /reagend|cambio de fecha|fecha/i],
  ['committed_issue', /despacho|programada|programado|pedido comprometido/i],
  ['complex_installation', /instalacion|coordinacion logistica|acceso/i],
  ['stock_confirm', /stock|disponibilidad/i],
  ['photos_eval', /foto|fotos|imagen/i],
];

const normalizeReason = (value) => String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

const motiveFromReason = (reason) => {
  const text = normalizeReason(reason);
  if (!text) return null;
  for (const [motive, pattern] of REASON_TO_MOTIVE) {
    if (pattern.test(text)) return motive;
  }
  return null;
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
  };
  }

  const intent = String(row.intent || '').trim();
  const rawReason = String(row.escalation_reason || '').trim();
  const motivo = motiveFromReason(rawReason)
    || INTENT_TO_MOTIVE[intent]
    || (area && area !== 'none' ? area : null);
  const routing = HANDOFF_ROUTING[motivo] || AREA_FALLBACK[area] || DEFAULT_ROUTING;
  const trigger = rawReason || (intent ? `intent:${intent}` : routing.area);

  return {
    escalated: true,
    write: true,
    motivo: motivo || routing.area,
    routing,
    trigger,
    idempotency_key: buildIdempotencyKey(conversationId, motivo || routing.area, trigger),
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
      },
    },
  ];
}