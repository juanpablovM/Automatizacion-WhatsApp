const V3_CONTRACTS = Object.freeze({
  policy: 'ai_prd_turn_policy/v3',
  proposal: 'ai_conversation_proposal/v3',
  validation: 'conversation_validation_result/v3',
  decision: 'validated_conversation_decision/v3',
});

const CONCEPT_TO_FIELD = Object.freeze({
  name: 'name',
  product: 'product',
  service: 'service',
  commune: 'commune',
  quantity: 'quantity',
  measurements: 'measurements',
  use_case: 'use_case',
  modality: 'modality',
  urgency: 'urgency',
  desired_date: 'desired_date',
  photos: 'photos',
  terrain: 'terrain',
  truck_access: 'truck_access',
  debris_removal: 'debris_removal',
  customer_type: 'customer_type',
  company: 'company',
  company_rut: 'company_rut',
  contact_name: 'contact_name',
  contact_role: 'contact_role',
  email: 'email',
  purchase_order: 'purchase_order',
  invoice_required: 'invoice_required',
  address: 'address',
  access_restrictions: 'access_restrictions',
  reception_contact: 'reception_contact',
  sale_number: 'sale_number',
  purchase_date: 'purchase_date',
  issue_description: 'issue_description',
  payment_amount: 'payment_amount',
  payment_method: 'payment_method',
  quote_number: 'quote_number',
});

const GROUNDED_CONCEPTS = new Set(['product', 'service', 'commune', 'modality']);
const TOP_LEVEL_PROPOSAL_KEYS = new Set([
  'version',
  'policy_digest',
  'reply_text',
  'primary_request',
  'observations',
  'state_mutations',
  'effect_requests',
]);
const OBSERVATION_KEYS = new Set([
  'id',
  'concept',
  'raw_value',
  'normalized_value',
  'evidence_quote',
  'evidence_occurrence',
  'grounding_ref',
  'resolves_goal_ids',
]);
const MUTATION_KEYS = new Set(['operation', 'field', 'observation_id', 'replaces_fact_id']);
const EFFECT_KEYS = new Set(['type', 'reason_observation_ids']);
const PRIMARY_REQUEST_KEYS = new Set(['text', 'goal_id']);

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const jsonClone = (value) => JSON.parse(JSON.stringify(value));
const stableValue = (value) => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (isObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .filter((key) => value[key] !== undefined)
        .sort()
        .map((key) => [key, stableValue(value[key])])
    );
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  return value;
};
const canonicalJson = (value) => JSON.stringify(stableValue(value));

const SHA256_K = Object.freeze([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const rotateRight = (value, bits) => (value >>> bits) | (value << (32 - bits));
const sha256 = (value) => {
  const bytes = new TextEncoder().encode(String(value));
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const bitLength = BigInt(bytes.length) * 8n;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Number((bitLength >> 32n) & 0xffffffffn));
  view.setUint32(paddedLength - 4, Number(bitLength & 0xffffffffn));

  const hash = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const words = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(offset + index * 4);
    for (let index = 16; index < 64; index += 1) {
      const left = words[index - 15];
      const right = words[index - 2];
      const sigma0 = rotateRight(left, 7) ^ rotateRight(left, 18) ^ (left >>> 3);
      const sigma1 = rotateRight(right, 17) ^ rotateRight(right, 19) ^ (right >>> 10);
      words[index] = (words[index - 16] + sigma0 + words[index - 7] + sigma1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const first = (h + sum1 + choice + SHA256_K[index] + words[index]) >>> 0;
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const second = (sum0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + first) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (first + second) >>> 0;
    }
    [a, b, c, d, e, f, g, h].forEach((part, index) => { hash[index] = (hash[index] + part) >>> 0; });
  }
  return hash.map((part) => part.toString(16).padStart(8, '0')).join('');
};

const digestObject = (value) => sha256(canonicalJson(value));
const digestPolicy = (policy) => {
  const copy = { ...policy };
  delete copy.policy_digest;
  return digestObject(copy);
};
const utf8Length = (value) => new TextEncoder().encode(String(value)).length;
const exactKeys = (value, allowed) => isObject(value)
  && Object.keys(value).every((key) => allowed.has(key));

const compileV3TurnPolicy = (input) => {
  if (!isObject(input?.turn) || !isObject(input.turn.message)) throw new Error('turn_message_required');
  const messageText = typeof input.turn.message.text === 'string' ? input.turn.message.text : '';
  const historyMessages = Array.isArray(input.history?.messages) ? jsonClone(input.history.messages) : [];
  const facts = Array.isArray(input.facts) ? jsonClone(input.facts) : [];
  const goals = Array.isArray(input.goals) ? jsonClone(input.goals) : [];
  const groundingInput = isObject(input.grounding) ? jsonClone(input.grounding) : {};
  const grounding = {
    catalog: Array.isArray(groundingInput.catalog) ? groundingInput.catalog : [],
    modality_synonyms: Array.isArray(groundingInput.modality_synonyms) ? groundingInput.modality_synonyms : [],
  };
  grounding.snapshot_digest = digestObject(grounding);

  const policy = {
    version: V3_CONTRACTS.policy,
    turn: {
      id: String(input.turn.id ?? ''),
      conversation_id: String(input.turn.conversation_id ?? ''),
      conversation_revision: Number(input.turn.conversation_revision ?? 0),
      message: {
        id: String(input.turn.message.id ?? ''),
        text: messageText,
        encoding: 'utf-8',
        sha256: sha256(messageText),
      },
    },
    history: {
      messages: historyMessages,
      truncated: Boolean(input.history?.truncated),
      sha256: digestObject(historyMessages),
    },
    facts,
    goals,
    conversation_policy: {
      normal_voice: 'ai_only',
      max_primary_requests: 1,
      may_answer_before_progressing: true,
      may_defer_commercial_goals: true,
      must_not_request_known_facts: true,
    },
    state_authority: {
      allowed_mutations: Array.isArray(input.allowed_mutations) ? jsonClone(input.allowed_mutations) : [],
    },
    grounding,
    claim_authority: {
      rules: Array.isArray(input.claim_rules) ? jsonClone(input.claim_rules) : [],
    },
    effect_authority: {
      permissions: Array.isArray(input.effect_permissions) ? jsonClone(input.effect_permissions) : [],
      requirements: Array.isArray(input.effect_requirements) ? jsonClone(input.effect_requirements) : [],
      operation_key_strategy: 'system_derived/v1',
    },
    commit_policy: {
      proposal_atomicity: 'all_or_nothing',
      effects_before_reply: true,
      delivery_idempotency: 'turn_reply/v1',
    },
    failure_policy: {
      max_repairs: 1,
      preserve_pre_turn_state: true,
      static_copy: 'contingency_only',
      handoff_after_exhaustion: true,
    },
  };
  return { ...policy, policy_digest: digestObject(policy) };
};

const validationError = (code, path, relatedIds = [], allowedValues = []) => ({
  code,
  path,
  disposition: 'repairable',
  related_ids: relatedIds,
  allowed_values: allowedValues,
});

const findOccurrence = (text, quote, occurrence) => {
  if (!quote || !Number.isInteger(occurrence) || occurrence < 1) return null;
  let from = 0;
  let index = -1;
  for (let count = 0; count < occurrence; count += 1) {
    index = text.indexOf(quote, from);
    if (index < 0) return null;
    from = index + quote.length;
  }
  return { index, end: index + quote.length };
};

const groundingEntries = (policy) => [
  ...(Array.isArray(policy.grounding?.catalog) ? policy.grounding.catalog : []),
  ...(Array.isArray(policy.grounding?.modality_synonyms) ? policy.grounding.modality_synonyms : []),
];
const groundingValue = (entry) => entry?.value ?? entry?.name ?? null;
const normalizedComparable = (value) => isObject(value)
  ? value.value ?? value.name ?? value.kind ?? canonicalJson(value)
  : value;
const sameGroundedValue = (left, right) => String(left ?? '').trim().toLocaleLowerCase('es')
  === String(right ?? '').trim().toLocaleLowerCase('es');

const validateV3AiProposal = (policy, proposal) => {
  const errors = [];
  const candidateObservations = [];
  const candidateMutations = [];
  const candidateEffects = [];
  const proposalObject = isObject(proposal) ? proposal : {};
  const policyDigestValid = policy?.version === V3_CONTRACTS.policy
    && typeof policy.policy_digest === 'string'
    && digestPolicy(policy) === policy.policy_digest;

  if (!policyDigestValid) errors.push(validationError('policy_invalid', 'policy'));
  if (!exactKeys(proposalObject, TOP_LEVEL_PROPOSAL_KEYS)) errors.push(validationError('proposal_shape_invalid', '$'));
  if (proposalObject.version !== V3_CONTRACTS.proposal) errors.push(validationError('proposal_version_invalid', 'version'));
  if (proposalObject.policy_digest !== policy?.policy_digest) errors.push(validationError('policy_digest_mismatch', 'policy_digest'));
  if (typeof proposalObject.reply_text !== 'string' || proposalObject.reply_text.length === 0) {
    errors.push(validationError('reply_text_invalid', 'reply_text'));
  }

  const primaryRequest = proposalObject.primary_request;
  if (primaryRequest !== null) {
    const requestValid = exactKeys(primaryRequest, PRIMARY_REQUEST_KEYS)
      && typeof primaryRequest.text === 'string'
      && primaryRequest.text.length > 0
      && typeof primaryRequest.goal_id === 'string'
      && (proposalObject.reply_text || '').includes(primaryRequest.text)
      && (policy?.goals || []).some((goal) => goal.goal_id === primaryRequest.goal_id);
    if (!requestValid) errors.push(validationError('primary_request_invalid', 'primary_request'));
  }

  const observations = Array.isArray(proposalObject.observations) ? proposalObject.observations : [];
  if (!Array.isArray(proposalObject.observations)) errors.push(validationError('observations_invalid', 'observations'));
  const observationIds = new Set();
  const messageText = typeof policy?.turn?.message?.text === 'string' ? policy.turn.message.text : '';
  const knownGoalIds = new Set((policy?.goals || []).map((goal) => goal.goal_id));
  for (const [index, observation] of observations.entries()) {
    const path = `observations[${index}]`;
    let valid = exactKeys(observation, OBSERVATION_KEYS)
      && typeof observation.id === 'string'
      && observation.id.length > 0
      && typeof observation.concept === 'string'
      && typeof observation.raw_value === 'string'
      && typeof observation.evidence_quote === 'string'
      && Array.isArray(observation.resolves_goal_ids);
    if (!valid) {
      errors.push(validationError('observation_shape_invalid', path));
      continue;
    }
    if (observationIds.has(observation.id)) {
      errors.push(validationError('observation_id_duplicate', `${path}.id`, [observation.id]));
      valid = false;
    }
    observationIds.add(observation.id);
    if (observation.resolves_goal_ids.some((goalId) => !knownGoalIds.has(goalId))) {
      errors.push(validationError('goal_reference_unknown', `${path}.resolves_goal_ids`, [observation.id]));
      valid = false;
    }
    const occurrence = findOccurrence(messageText, observation.evidence_quote, observation.evidence_occurrence);
    if (!occurrence) {
      errors.push(validationError('evidence_quote_not_found', `${path}.evidence_quote`, [observation.id]));
      valid = false;
    }
    if (GROUNDED_CONCEPTS.has(observation.concept)) {
      const grounding = groundingEntries(policy).find((entry) => entry.ref === observation.grounding_ref);
      const groundingValid = grounding
        && (!grounding.concept || grounding.concept === observation.concept)
        && sameGroundedValue(groundingValue(grounding), normalizedComparable(observation.normalized_value));
      if (!groundingValid) {
        errors.push(validationError('grounding_invalid', `${path}.grounding_ref`, [observation.id]));
        valid = false;
      }
    }
    if (valid && occurrence) {
      const startByte = utf8Length(messageText.slice(0, occurrence.index));
      const endByte = startByte + utf8Length(observation.evidence_quote);
      candidateObservations.push({
        ...jsonClone(observation),
        evidence: {
          message_id: policy.turn.message.id,
          quote: observation.evidence_quote,
          occurrence: observation.evidence_occurrence,
          start_byte: startByte,
          end_byte: endByte,
          sha256: sha256(`${policy.turn.message.id}\u0000${startByte}\u0000${endByte}\u0000${observation.evidence_quote}`),
        },
      });
    }
  }

  const observationsById = new Map(candidateObservations.map((observation) => [observation.id, observation]));
  const factsById = new Map((policy?.facts || []).map((fact) => [fact.fact_id, fact]));
  const allowedMutations = Array.isArray(policy?.state_authority?.allowed_mutations)
    ? policy.state_authority.allowed_mutations
    : [];
  const mutations = Array.isArray(proposalObject.state_mutations) ? proposalObject.state_mutations : [];
  if (!Array.isArray(proposalObject.state_mutations)) errors.push(validationError('state_mutations_invalid', 'state_mutations'));
  for (const [index, mutation] of mutations.entries()) {
    const path = `state_mutations[${index}]`;
    const observation = observationsById.get(mutation?.observation_id);
    if (!exactKeys(mutation, MUTATION_KEYS) || !['set', 'replace'].includes(mutation?.operation) || !observation) {
      errors.push(validationError('mutation_shape_invalid', path, mutation?.observation_id ? [mutation.observation_id] : []));
      continue;
    }
    const canonicalField = CONCEPT_TO_FIELD[observation.concept];
    const allowed = allowedMutations.some((entry) => entry.operation === mutation.operation
      && entry.concept === observation.concept
      && entry.field === mutation.field
      && (mutation.operation !== 'replace' || entry.current_fact_id === mutation.replaces_fact_id));
    if (!canonicalField || canonicalField !== mutation.field || !allowed) {
      errors.push(validationError('mutation_mapping_forbidden', `${path}.field`, [observation.id], canonicalField ? [canonicalField] : []));
      continue;
    }
    if (mutation.operation === 'set' && mutation.replaces_fact_id !== null) {
      errors.push(validationError('set_cannot_replace_fact', `${path}.replaces_fact_id`, [observation.id]));
      continue;
    }
    if (mutation.operation === 'replace') {
      const fact = factsById.get(mutation.replaces_fact_id);
      if (!fact || fact.field !== mutation.field || fact.mutability !== 'customer_correctable') {
        errors.push(validationError('fact_not_replaceable', `${path}.replaces_fact_id`, [observation.id]));
        continue;
      }
    }
    candidateMutations.push({
      operation: mutation.operation,
      field: mutation.field,
      observation_id: observation.id,
      replaces_fact_id: mutation.replaces_fact_id,
      projected_value: jsonClone(observation.normalized_value),
    });
  }

  for (const rule of policy?.claim_authority?.rules || []) {
    if (rule?.kind !== 'forbidden_pattern' || typeof rule.pattern !== 'string') continue;
    let pattern;
    try {
      pattern = new RegExp(rule.pattern, String(rule.flags || 'iu').replace(/g/g, ''));
    } catch (_error) {
      errors.push(validationError('claim_rule_invalid', 'policy.claim_authority.rules', [rule.rule_id].filter(Boolean)));
      continue;
    }
    if (pattern.test(proposalObject.reply_text || '')) {
      errors.push(validationError('forbidden_claim', 'reply_text', [rule.rule_id].filter(Boolean)));
    }
  }

  const permissions = new Set((policy?.effect_authority?.permissions || []).map((permission) => permission.type));
  const requirements = new Map((policy?.effect_authority?.requirements || []).map((requirement) => [requirement.effect_type, requirement]));
  const resolvedGoalIds = new Set([
    ...(policy?.goals || []).filter((goal) => goal.status === 'resolved').map((goal) => goal.goal_id),
    ...candidateObservations.flatMap((observation) => observation.resolves_goal_ids),
  ]);
  const effects = Array.isArray(proposalObject.effect_requests) ? proposalObject.effect_requests : [];
  if (!Array.isArray(proposalObject.effect_requests)) errors.push(validationError('effect_requests_invalid', 'effect_requests'));
  for (const [index, effect] of effects.entries()) {
    const path = `effect_requests[${index}]`;
    if (!exactKeys(effect, EFFECT_KEYS) || typeof effect.type !== 'string' || !Array.isArray(effect.reason_observation_ids)) {
      errors.push(validationError('effect_shape_invalid', path));
      continue;
    }
    if (!permissions.has(effect.type)) {
      errors.push(validationError('effect_not_permitted', `${path}.type`, [], [...permissions]));
      continue;
    }
    const unknownObservation = effect.reason_observation_ids.find((id) => !observationsById.has(id));
    if (unknownObservation) {
      errors.push(validationError('effect_observation_unknown', `${path}.reason_observation_ids`, [unknownObservation]));
      continue;
    }
    const requiredGoalIds = requirements.get(effect.type)?.required_goal_ids || [];
    const unresolved = requiredGoalIds.filter((goalId) => !resolvedGoalIds.has(goalId));
    if (unresolved.length > 0) {
      errors.push(validationError('effect_prerequisite_unresolved', path, unresolved));
      continue;
    }
    candidateEffects.push(jsonClone(effect));
  }

  const valid = errors.length === 0;
  return {
    version: V3_CONTRACTS.validation,
    valid,
    policy_digest: policy?.policy_digest || null,
    proposal_digest: isObject(proposal) ? digestObject(proposal) : null,
    errors,
    accepted_observations: valid ? candidateObservations : [],
    authorized_mutations: valid ? candidateMutations : [],
    authorized_effect_requests: valid ? candidateEffects : [],
  };
};

module.exports = {
  V3_CONTRACTS,
  CONCEPT_TO_FIELD,
  GROUNDED_CONCEPTS,
  canonicalJson,
  sha256,
  digestObject,
  compileV3TurnPolicy,
  validateV3AiProposal,
};
