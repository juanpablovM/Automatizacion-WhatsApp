const asObject = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const asArray = (value) => Array.isArray(value) ? value : [];
const safe = (value, fallback = '') => String(value ?? fallback).trim();
const error = (code, path, detail = null) => ({ code, path, detail });

const utf8Slice = (text, start, end) => {
  const bytes = typeof Buffer !== 'undefined'
    ? Buffer.from(String(text), 'utf8')
    : new TextEncoder().encode(String(text));
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > bytes.length) return null;
  if (typeof Buffer !== 'undefined') return bytes.subarray(start, end).toString('utf8');
  return new TextDecoder().decode(bytes.slice(start, end));
};

const validateAiProposal = (row = {}) => {
  const policy = asObject(row.turn_policy);
  const proposal = asObject(row.ai_proposal);
  const errors = [];
  if (policy.version !== 'ai_prd_turn_policy/v2') errors.push(error('unsupported_policy_version', 'turn_policy.version'));
  if (proposal.version !== 'ai_semantic_proposal/v2') errors.push(error('unsupported_proposal_version', 'ai_proposal.version'));
  if (proposal.contract_digest !== row.turn_policy_digest) errors.push(error('contract_digest_mismatch', 'ai_proposal.contract_digest'));
  if (typeof proposal.reply_text !== 'string') errors.push(error('reply_text_required', 'ai_proposal.reply_text'));
  if (!asArray(policy.allowed_dialogue_actions).includes(proposal.dialogue_action)) {
    errors.push(error('dialogue_action_not_allowed', 'ai_proposal.dialogue_action'));
  }

  const sourceMessage = asObject(policy.message);
  const seenIds = new Set();
  const acceptedObservations = [];
  for (const [index, candidate] of asArray(proposal.observations).entries()) {
    const observation = asObject(candidate);
    const id = safe(observation.id);
    const evidence = asObject(observation.evidence);
    const path = `ai_proposal.observations[${index}]`;
    let accepted = true;
    if (!id || seenIds.has(id)) {
      errors.push(error(id ? 'duplicate_observation_id' : 'observation_id_required', `${path}.id`));
      accepted = false;
    }
    seenIds.add(id);
    if (!safe(observation.concept)) {
      errors.push(error('observation_concept_required', `${path}.concept`));
      accepted = false;
    }
    const quotedBytes = utf8Slice(sourceMessage.text, evidence.start, evidence.end);
    if (safe(evidence.message_id) !== safe(sourceMessage.id)) {
      errors.push(error('evidence_message_mismatch', `${path}.evidence.message_id`));
      accepted = false;
    }
    if (quotedBytes === null || quotedBytes !== String(evidence.quote ?? '')) {
      errors.push(error('invalid_evidence_offsets', `${path}.evidence`));
      accepted = false;
    }
    const confidence = Number(observation.confidence);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      errors.push(error('invalid_observation_confidence', `${path}.confidence`));
      accepted = false;
    }
    if (accepted) acceptedObservations.push(observation);
  }

  const observationById = new Map(acceptedObservations.map((observation) => [safe(observation.id), observation]));
  const allowedFields = new Set(asArray(policy.allowed_state_fields));
  const authorizedStatePatch = [];
  for (const [index, candidate] of asArray(proposal.state_patch).entries()) {
    const patch = asObject(candidate);
    const path = `ai_proposal.state_patch[${index}]`;
    let accepted = true;
    if (!allowedFields.has(patch.field)) {
      errors.push(error('state_field_not_allowed', `${path}.field`, patch.field));
      accepted = false;
    }
    if (!observationById.has(safe(patch.observation_id))) {
      errors.push(error('observation_reference_not_found', `${path}.observation_id`, patch.observation_id));
      accepted = false;
    }
    if (accepted) authorizedStatePatch.push({ field: patch.field, observation_id: patch.observation_id });
  }

  const permissions = asObject(policy.effect_permissions);
  const authorizedEffects = [];
  const effectKeys = new Set();
  for (const [index, candidate] of asArray(proposal.requested_effects).entries()) {
    const effect = asObject(candidate);
    const type = safe(effect.type);
    const path = `ai_proposal.requested_effects[${index}]`;
    if (!['create_lead', 'handoff'].includes(type) || permissions[type] !== true) {
      errors.push(error('effect_not_allowed', `${path}.type`, type));
      continue;
    }
    const key = safe(effect.idempotency_key, `${type}:${row.turn_policy_digest}`);
    if (effectKeys.has(key)) continue;
    effectKeys.add(key);
    authorizedEffects.push({ ...effect, type, idempotency_key: key });
  }

  return {
    valid: errors.length === 0,
    rule_errors: errors,
    accepted_observations: acceptedObservations,
    authorized_state_patch: errors.length === 0 ? authorizedStatePatch : [],
    authorized_effects: errors.length === 0 ? authorizedEffects : [],
    outcome: errors.length === 0 ? 'authorized' : 'repair_required',
  };
};

if (typeof module !== 'undefined' && module.exports) module.exports = { validateAiProposal, utf8Slice };

if (typeof items !== 'undefined') {
  return items.map((item) => ({ json: { ...item.json, ai_validation: validateAiProposal(item.json) } }));
}
