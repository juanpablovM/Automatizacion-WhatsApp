const asObject = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const safe = (value, fallback = '') => String(value ?? fallback).trim();
const cloneObject = (value) => JSON.parse(JSON.stringify(asObject(value)));
const mergeValue = (row, field) => Object.prototype.hasOwnProperty.call(row, `${field}_1`)
  ? row[`${field}_1`]
  : row[field];

const failureReason = (kind) => kind === 'provider_unavailable'
  ? 'ai_provider_unavailable'
  : 'ai_semantic_repair_failed';

const buildContingencyHandoff = (row = {}) => {
  const snapshot = cloneObject(mergeValue(row, 'pre_turn_snapshot'));
  const policy = asObject(mergeValue(row, 'turn_policy'));
  const turnId = safe(
    policy.turn_id,
    mergeValue(row, 'inbound_event_id') || mergeValue(row, 'conversation_id') || 'unknown'
  );
  const idempotencyKey = `semantic-handoff:${turnId}`;
  const failureKind = safe(row.ai_failure_kind)
    || (safe(row.ai_fallback_reason) ? 'provider_unavailable' : 'repair_invalid');
  const reason = failureReason(failureKind);
  const qualificationContext = cloneObject(snapshot.qualification_context);

  return {
    ...row,
    service: snapshot.service ?? row.service ?? null,
    city: snapshot.city ?? row.city ?? null,
    requirement: snapshot.requirement ?? row.requirement ?? null,
    confirmation_status: snapshot.confirmation_status ?? row.confirmation_status ?? 'none',
    qualification_context: qualificationContext,
    qualification_context_json: JSON.stringify(qualificationContext),
    response_text: 'No pude completar este paso de forma segura. Voy a derivar tu conversación al equipo para que pueda ayudarte.',
    reply_text: 'No pude completar este paso de forma segura. Voy a derivar tu conversación al equipo para que pueda ayudarte.',
    conversation_status_code: 'escalation_required',
    should_escalate: true,
    escalation_required: true,
    escalation_reason: reason,
    escalation_area: 'sales',
    dialogue_action: 'handoff',
    authorized_state_patch: [],
    authorized_effects: [{ type: 'handoff', idempotency_key: idempotencyKey, reason }],
    ai_authorization_outcome: 'contingency',
  };
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { buildContingencyHandoff, failureReason };
}

if (typeof items !== 'undefined') {
  return items.map((item) => ({ json: buildContingencyHandoff(item?.json ?? {}) }));
}
