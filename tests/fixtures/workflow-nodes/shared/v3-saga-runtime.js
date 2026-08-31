const { createHash } = require('crypto');

const canonicalJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
};
const sha256 = (value) => createHash('sha256').update(String(value), 'utf8').digest('hex');
const digestObject = (value) => sha256(canonicalJson(value));
const cloneJsonValue = (value) => {
  if (value === null) return null;
  if (Array.isArray(value)) return value.map(cloneJsonValue);
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, cloneJsonValue(nested)]),
    );
  }
  if (['string', 'number', 'boolean'].includes(typeof value)) return value;
  throw new Error('non_json_recovery_state');
};
const requirePolicy = (policy) => {
  if (policy?.version !== 'ai_prd_turn_policy/v3' || !policy.policy_digest) {
    throw new Error('invalid_v3_policy');
  }
  return policy;
};

function buildV3RepairRequest({ policy, validation, repairAttempt = 0 }) {
  requirePolicy(policy);
  if (repairAttempt !== 0) throw new Error('repair_limit_exhausted');
  if (validation?.version !== 'conversation_validation_result/v3'
      || validation.valid !== false || !Array.isArray(validation.errors)
      || validation.errors.length === 0) {
    throw new Error('repair_requires_machine_errors');
  }
  const decision = {
    schema: 'ai_conversation_repair_request/v3',
    policy_digest: policy.policy_digest,
    policy,
    complete_repair: true,
    repair_attempt: 1,
    errors: validation.errors,
  };
  return { ...decision, decision_digest: digestObject(decision) };
}

function buildV3ContingencyDecision({ policy, reason, expectedSnapshotDigest }) {
  requirePolicy(policy);
  const turnId = String(policy.turn?.id || 'unknown-turn');
  const stableSeed = `${policy.policy_digest}:${turnId}:contingency`;
  const decisionId = `v3-contingency:${sha256(stableSeed).slice(0, 32)}`;
  const operationKey = `v3-handoff:${sha256(`${stableSeed}:handoff`).slice(0, 32)}`;
  const deliveryKey = `v3-delivery:${sha256(`${stableSeed}:delivery`).slice(0, 32)}`;
  const payload = {
    motive: 'v3_recovery',
    area: 'sales',
    area_label: 'Ventas',
    priority: 'alta',
    owner: 'Equipo Ventas',
    trigger: turnId,
    recovery_reason: String(reason || 'terminal_v3_failure'),
  };
  const replyText = 'No pude completar la gestión automática. Derivé el caso al equipo para revisión.';
  const decision = {
    version: 'system_contingency_decision/v3',
    decision_id: decisionId,
    expected_snapshot_digest: expectedSnapshotDigest || null,
    policy_digest: policy.policy_digest,
    reply: { text: replyText, sha256: sha256(replyText), delivery_key: deliveryKey },
    state_mutations: [],
    effect_commands: [{
      type: 'internal_handoff',
      operation_key: operationKey,
      payload,
      payload_digest: digestObject(payload),
      required_before_reply: true,
    }],
  };
  return { ...decision, decision_digest: digestObject(decision) };
}

function planV3Recovery({
  policy, validation, repairAttempt = 0, providerOutcome = 'accepted', preTurnState,
  expectedSnapshotDigest,
}) {
  requirePolicy(policy);
  const preservedState = cloneJsonValue(preTurnState ?? {});
  if (providerOutcome === 'outage' || repairAttempt >= 1) {
    return {
      action: 'contingency',
      decision: buildV3ContingencyDecision({
        policy,
        reason: providerOutcome === 'outage' ? 'provider_outage' : 'repair_exhausted',
        expectedSnapshotDigest,
      }),
      preserved_state: preservedState,
    };
  }
  if (validation?.valid === false) {
    return {
      action: 'repair',
      repair_request: buildV3RepairRequest({ policy, validation, repairAttempt }),
      preserved_state: preservedState,
    };
  }
  return { action: 'resume', preserved_state: preservedState };
}

function releaseV3Contingency({ decision, handoffReceipt }) {
  if (decision?.version !== 'system_contingency_decision/v3') {
    throw new Error('invalid_v3_contingency');
  }
  const command = decision.effect_commands?.find((effect) => effect.type === 'internal_handoff');
  const receipted = Boolean(
    command
      && handoffReceipt?.status === 'succeeded'
      && handoffReceipt.operation_key === command.operation_key
      && handoffReceipt.handoff_id,
  );
  return {
    release_delivery: receipted,
    reply_text: receipted ? decision.reply.text : null,
    delivery_key: receipted ? decision.reply.delivery_key : null,
    handoff_receipt: receipted ? handoffReceipt : null,
  };
}

function reconcileV3Operation({ operation, operationKey, payloadDigest, matches, completeSearch }) {
  if (operation?.operation_key !== operationKey
      || operation?.payload_digest !== payloadDigest) {
    return { resolution: 'key_mismatch', retry_authorized: false, recovery_required: true };
  }
  if (!completeSearch) {
    return { resolution: 'inconclusive', retry_authorized: false, recovery_required: true };
  }
  if (matches === 0) {
    return { resolution: 'no_effect_proven', retry_authorized: true, recovery_required: false };
  }
  if (matches === 1) {
    return { resolution: 'succeeded', retry_authorized: false, recovery_required: false };
  }
  return { resolution: 'duplicate', retry_authorized: false, recovery_required: true };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    canonicalJson,
    sha256,
    digestObject,
    cloneJsonValue,
    buildV3RepairRequest,
    buildV3ContingencyDecision,
    planV3Recovery,
    releaseV3Contingency,
    reconcileV3Operation,
  };
}
