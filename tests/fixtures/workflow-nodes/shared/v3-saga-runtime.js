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

function buildV3RepairRequest({ policy, validation, proposal = null, repairAttempt = 0 }) {
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
    rejected_proposal: cloneJsonValue(proposal),
    catalog_resolution: cloneJsonValue(validation.catalog_resolution ?? null),
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
  const replyText = reason === 'no_progress_commercial_question_loop'
    ? 'No quiero hacerte repetir lo mismo. Registré el caso para revisión por una persona del equipo.'
    : 'No pude completar la gestión automática. Derivé el caso al equipo para revisión.';
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

// `Normalize AI Result` already separates a provider that never answered from a
// model that answered badly: only a non-2xx response leaves `provider_error` or
// `rate_limited`, while `invalid_json`, `intent_mismatch` and `low_confidence`
// all mean the reply arrived and was poor, which is exactly what repair is for.
// `missing_ai_request` stays off this list on purpose, because a request we
// failed to build is our own misconfiguration and must not hide behind the
// provider. `planV3Recovery` has had an `outage` branch from the start, but
// nothing ever wrote `v3_provider_outcome`, so it read its default: every outage
// was filed as `repair_exhausted`, indistinguishable from a proposal we could
// not fix, and the turn first spent a repair call on a provider that had just
// refused two. The merge suffixes the AI side, so the signal is read the way the
// rejected proposal is.
const PROVIDER_SILENT_REASONS = new Set(['provider_error', 'rate_limited']);
const resolveV3ProviderOutcome = (mergedInput, input) => {
  const source = mergedInput && typeof mergedInput === 'object' ? mergedInput : {};
  const canonical = input && typeof input === 'object' ? input : {};
  if (canonical.v3_provider_outcome) return canonical.v3_provider_outcome;
  const reason = source.ai_fallback_reason
    ?? source.ai_fallback_reason_2
    ?? source.ai_fallback_reason_1;
  return PROVIDER_SILENT_REASONS.has(String(reason ?? '')) ? 'outage' : 'accepted';
};

function planV3Recovery({
  policy, validation, repairAttempt = 0, providerOutcome = 'accepted', preTurnState,
  expectedSnapshotDigest, proposal = null,
}) {
  requirePolicy(policy);
  const preservedState = cloneJsonValue(preTurnState ?? {});
  if (providerOutcome === 'outage' || repairAttempt >= 1) {
    return {
      action: 'contingency',
      decision: buildV3ContingencyDecision({
        policy,
        reason: (validation?.errors || []).some((error) => String(error.code || '').startsWith('address_retry_'))
          ? 'no_progress_commercial_question_loop'
          : providerOutcome === 'outage' ? 'provider_outage' : 'repair_exhausted',
        expectedSnapshotDigest,
      }),
      preserved_state: preservedState,
    };
  }
  if (validation?.valid === false) {
    return {
      action: 'repair',
      repair_request: buildV3RepairRequest({ policy, validation, proposal, repairAttempt }),
      preserved_state: preservedState,
    };
  }
  return { action: 'resume', preserved_state: preservedState };
}

// n8n prunes executions after about two days, and the contingency decision only
// keeps a coarse `recovery_reason`, so the cause of a fallback used to vanish
// with the execution. This is the durable part of that cause: machine codes and
// small scalars, never the rejected proposal, the prompt or the customer's
// words. A value that does not look like a machine code is dropped, not
// truncated, because a truncated free-form message is still free-form text.
const DIAGNOSTIC_CODE = /^[A-Za-z0-9_.:-]{1,64}$/;
const DIAGNOSTIC_CODE_LIMIT = 20;
const diagnosticCode = (value) =>
  (typeof value === 'string' && DIAGNOSTIC_CODE.test(value) ? value : null);
const diagnosticInteger = (value, min, max) =>
  (Number.isInteger(value) && value >= min && value <= max ? value : null);

function buildV3ContingencyDiagnostic({ validation, providerOutcome, repairAttempt, mergedInput }) {
  const source = mergedInput && typeof mergedInput === 'object' ? mergedInput : {};
  // On an outage the model never answered, so the only validation left is that
  // of an absent proposal: it describes the gap, not the cause.
  const errors = providerOutcome === 'outage' || !Array.isArray(validation?.errors)
    ? []
    : validation.errors;
  const codes = [];
  for (const error of errors) {
    const code = diagnosticCode(error?.code);
    if (code && !codes.includes(code)) codes.push(code);
    if (codes.length === DIAGNOSTIC_CODE_LIMIT) break;
  }
  // The AI side of `Merge AI Assistance` is suffixed, and canonicalization drops
  // it, so the provider signal is read from the merged item the way
  // `resolveV3ProviderOutcome` reads it.
  return {
    validation_error_codes: codes,
    ai_fallback_reason: diagnosticCode(
      source.ai_fallback_reason ?? source.ai_fallback_reason_2 ?? source.ai_fallback_reason_1,
    ),
    ai_status_code: diagnosticInteger(
      source.ai_status_code ?? source.ai_status_code_2 ?? source.ai_status_code_1, 100, 599,
    ),
    repair_attempt: diagnosticInteger(repairAttempt, 0, 100),
  };
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

const MERGE_SUFFIX = /_(1|2)$/;

// `Merge AI Assistance` combines with `addSuffix`, so every field arriving here
// carries the input it came from in its name: `_1` for the policy side, `_2` for
// the AI side. Re-emitting that shape suffixes it again on the next pass through
// the merge (`contract_version_1_1`), and the nodes downstream read the single
// suffix produced by the first cycle. Rebuild the canonical item instead.
const canonicalizeMergedTurnItem = (input) => {
  const source = input && typeof input === 'object' ? input : {};
  const canonical = {};
  // Fields contributed after the merge carry no suffix; keep them.
  for (const [key, value] of Object.entries(source)) {
    if (!MERGE_SUFFIX.test(key)) canonical[key] = value;
  }
  // The policy side is the authoritative turn context, so it wins over a stale
  // bare field of the same name. The AI side is dropped: carrying it forward is
  // what compounds the suffixes.
  for (const [key, value] of Object.entries(source)) {
    if (key.endsWith('_1')) canonical[key.slice(0, -2)] = value;
  }
  return canonical;
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    canonicalJson,
    sha256,
    digestObject,
    cloneJsonValue,
    canonicalizeMergedTurnItem,
    resolveV3ProviderOutcome,
    buildV3RepairRequest,
    buildV3ContingencyDecision,
    planV3Recovery,
    buildV3ContingencyDiagnostic,
    releaseV3Contingency,
    reconcileV3Operation,
  };
}
