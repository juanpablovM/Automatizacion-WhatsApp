return items.map((item) => {
  const input = item.json || {};
  if (input.contract_version !== 'v3') return { json: input };
  const policy = compileV3TurnPolicy(buildV3PolicyInput(input));
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
