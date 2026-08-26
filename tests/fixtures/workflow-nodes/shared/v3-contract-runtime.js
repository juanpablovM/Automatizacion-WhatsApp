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

module.exports = {
  V3_CONTRACTS,
  CONCEPT_TO_FIELD,
  GROUNDED_CONCEPTS,
  canonicalJson,
  sha256,
  digestObject,
  compileV3TurnPolicy,
};
