const asObject = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const asArray = (value) => Array.isArray(value) ? value : [];
const safe = (value, fallback = '') => String(value ?? fallback).trim();
const cloneObject = (value) => JSON.parse(JSON.stringify(asObject(value)));
const parseObject = (value) => {
  if (typeof value !== 'string') return cloneObject(value);
  try { return cloneObject(JSON.parse(value)); } catch (_error) { return {}; }
};

const projectedValue = (field, observation) => {
  if (field !== 'modality') return observation.raw_value;
  const normalized = observation.normalized;
  const candidate = typeof normalized === 'string' ? normalized : asObject(normalized).value;
  return ['material', 'pickup', 'delivery', 'installation', 'post_sale', 'claim'].includes(candidate)
    ? candidate
    : observation.raw_value;
};

const authorizeAiTurn = (row = {}) => {
  const policy = asObject(row.turn_policy);
  const proposal = asObject(row.ai_proposal);
  const validation = asObject(row.ai_validation);
  const qualificationContext = cloneObject(row.qualification_context);
  const mode = safe(policy.mode, 'legacy');

  if (policy.version !== 'ai_prd_turn_policy/v2' || mode === 'legacy') {
    return {
      ...row,
      qualification_context: qualificationContext,
      qualification_context_json: JSON.stringify(qualificationContext),
      authorized_effects: [],
      ai_authorization_outcome: 'legacy_passthrough',
    };
  }
  if (validation.valid !== true && mode !== 'shadow') {
    return {
      ...row,
      qualification_context: qualificationContext,
      qualification_context_json: JSON.stringify(qualificationContext),
      ai_authorization_outcome: 'rejected',
      authorized_effects: [],
    };
  }
  if (mode === 'shadow') {
    const metadata = parseObject(row.metadata_json);
    metadata.semantic_shadow = {
      contract_digest: row.turn_policy_digest || null,
      proposal_reply_differs: String(proposal.reply_text ?? '') !== String(row.response_text ?? ''),
      proposed_patch_count: asArray(validation.authorized_state_patch).length,
      proposed_effect_count: asArray(validation.authorized_effects).length,
      validation_outcome: validation.outcome || 'authorized',
    };
    return {
      ...row,
      qualification_context: qualificationContext,
      qualification_context_json: JSON.stringify(qualificationContext),
      authorized_effects: [],
      shadow_ai_proposal: proposal,
      shadow_ai_validation: validation,
      metadata_json: JSON.stringify(metadata),
      ai_authorization_outcome: 'shadow_audited',
    };
  }

  const observations = new Map(asArray(validation.accepted_observations)
    .map((observation) => [safe(observation?.id), observation]));
  const acceptedFields = new Set(asArray(policy.accepted_facts)
    .map((fact) => safe(fact?.field))
    .filter(Boolean));
  const allowedMappings = new Set(asArray(policy.allowed_state_mappings)
    .map((mapping) => `${safe(mapping?.concept)}:${safe(mapping?.field)}`));
  const topLevelState = {};
  const appliedStatePatch = [];
  for (const patch of asArray(validation.authorized_state_patch)) {
    const observation = observations.get(safe(patch?.observation_id));
    const mappingKey = `${safe(observation?.concept)}:${safe(patch?.field)}`;
    if (!observation || acceptedFields.has(safe(patch?.field)) || !allowedMappings.has(mappingKey)) continue;
    const value = projectedValue(patch.field, observation);
    qualificationContext[patch.field] = value;
    if (['service', 'city', 'requirement'].includes(patch.field)) topLevelState[patch.field] = value;
    appliedStatePatch.push(patch);
  }

  const control = cloneObject(qualificationContext._conversation_control);
  control.objectives = cloneObject(control.objectives);
  const objectiveKey = safe(asObject(policy.objective).key, 'none');
  let dialogueAction = proposal.dialogue_action;
  if (objectiveKey !== 'none') {
    const previousObjective = asObject(control.objectives[objectiveKey]);
    const answered = asArray(validation.accepted_observations)
      .some((observation) => safe(observation?.answers_objective) === objectiveKey);
    const noProgressCount = answered ? 0 : Math.max(0, Number(previousObjective.no_progress_count) || 0) + 1;
    control.objectives[objectiveKey] = { ...previousObjective, no_progress_count: noProgressCount };
    if (noProgressCount >= 3) dialogueAction = 'handoff';
    else if (noProgressCount === 2) dialogueAction = 'ask_clarification';
  }
  qualificationContext._conversation_control = control;

  const executedKeys = new Set(asArray(control.executed_effect_keys).map((key) => safe(key)).filter(Boolean));
  const emittedKeys = new Set();
  const authorizedEffects = [];
  const addEffect = (effect) => {
    const type = safe(effect?.type);
    const key = safe(effect?.idempotency_key, `${type}:${row.turn_policy_digest}`);
    if (!key || executedKeys.has(key) || emittedKeys.has(key)) return;
    emittedKeys.add(key);
    authorizedEffects.push({ ...effect, type, idempotency_key: key });
  };
  for (const effect of asArray(validation.authorized_effects)) addEffect(effect);
  if (dialogueAction === 'handoff' && asObject(policy.effect_permissions).handoff === true) {
    addEffect({
      type: 'handoff',
      idempotency_key: `semantic-handoff:${safe(policy.turn_id, row.turn_policy_digest)}`,
      reason: 'objective_no_progress_limit',
    });
  }

  return {
    ...row,
    ...topLevelState,
    qualification_context: qualificationContext,
    qualification_context_json: JSON.stringify(qualificationContext),
    response_text: String(proposal.reply_text ?? ''),
    reply_text: String(proposal.reply_text ?? ''),
    dialogue_action: dialogueAction,
    accepted_observations: asArray(validation.accepted_observations),
    authorized_state_patch: appliedStatePatch,
    authorized_effects: authorizedEffects,
    ai_authorization_outcome: 'authorized',
  };
};

if (typeof module !== 'undefined' && module.exports) module.exports = { authorizeAiTurn, projectedValue };

if (typeof items !== 'undefined') {
  return items.map((item) => ({ json: authorizeAiTurn(item?.json ?? {}) }));
}
