// Slice 2b (design.md D7), dark by default: AI_PRD_V3_LINE_ITEMS gates the
// item-aware v3.1 policy per turn, phone-scoped in canary. Mirrors the
// AI_PRD_CONTRACT_CANARY_PHONES pattern in
// resolve-conversation-contract-route.js:13-23. Any value other than the
// three known ones fails safe to disabled — never to canary or enabled.
const digitsOnly = (value) => String(value ?? '').replace(/\D/g, '');
const LINE_ITEMS_MODES = new Set(['disabled', 'canary', 'enabled']);
const rawLineItemsMode = String($env.AI_PRD_V3_LINE_ITEMS ?? 'disabled').toLowerCase();
const lineItemsMode = LINE_ITEMS_MODES.has(rawLineItemsMode) ? rawLineItemsMode : 'disabled';
const lineItemsCanaryPhones = new Set(
  String($env.AI_PRD_V3_LINE_ITEMS_CANARY_PHONES || '')
    .split(',')
    .map(digitsOnly)
    .filter(Boolean),
);

return items.map((item) => {
  const input = item.json || {};
  if (input.contract_version !== 'v3') return { json: input };
  const usesLineItems = lineItemsMode === 'enabled'
    || (lineItemsMode === 'canary' && lineItemsCanaryPhones.has(digitsOnly(input.phone_number)));
  const policy = compileV3TurnPolicy(buildV3PolicyInput(input, { version: usesLineItems ? 'v3.1' : 'v3' }));
  return { json: {
    ...input,
    turn_policy: policy,
    v3_policy: policy,
    policy_digest: policy.policy_digest,
    expected_snapshot_digest: digestObject({
      conversation_revision: policy.turn.conversation_revision,
      facts: policy.facts,
    }),
    expected_snapshot: {
      conversation_revision: policy.turn.conversation_revision,
      facts: policy.facts,
    },
  } };
});
