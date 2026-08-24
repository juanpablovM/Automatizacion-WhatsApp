const asObject = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const asArray = (value) => Array.isArray(value) ? value : [];
const safe = (value, fallback = '') => String(value ?? fallback).trim();

const authorizeAiTurn = (row = {}) => {
  const proposal = asObject(row.ai_proposal);
  const validation = asObject(row.ai_validation);
  const qualificationContext = { ...asObject(row.qualification_context) };
  if (validation.valid !== true) {
    return {
      ...row,
      qualification_context: qualificationContext,
      ai_authorization_outcome: 'rejected',
      authorized_effects: [],
    };
  }

  const observations = new Map(asArray(validation.accepted_observations)
    .map((observation) => [safe(observation?.id), observation]));
  for (const patch of asArray(validation.authorized_state_patch)) {
    const observation = observations.get(safe(patch?.observation_id));
    if (!observation) continue;
    qualificationContext[patch.field] = observation.raw_value;
  }

  const authorizedEffects = [];
  const consumed = new Set();
  for (const effect of asArray(validation.authorized_effects)) {
    const key = safe(effect?.idempotency_key, `${safe(effect?.type)}:${row.turn_policy_digest}`);
    if (!key || consumed.has(key)) continue;
    consumed.add(key);
    authorizedEffects.push({ ...effect, idempotency_key: key });
  }

  return {
    ...row,
    qualification_context: qualificationContext,
    qualification_context_json: JSON.stringify(qualificationContext),
    response_text: String(proposal.reply_text ?? ''),
    reply_text: String(proposal.reply_text ?? ''),
    dialogue_action: proposal.dialogue_action,
    accepted_observations: asArray(validation.accepted_observations),
    authorized_state_patch: asArray(validation.authorized_state_patch),
    authorized_effects: authorizedEffects,
    ai_authorization_outcome: 'authorized',
  };
};

if (typeof module !== 'undefined' && module.exports) module.exports = { authorizeAiTurn };

if (typeof items !== 'undefined') {
  return items.map((item) => ({ json: authorizeAiTurn(item?.json ?? {}) }));
}
