return items.map((item) => {
  const envelope = item.json || {};
  const input = envelope.shadow_payload || envelope;
  const policy = compileV3TurnPolicy(buildV3PolicyInput({ ...input, shadow_mode: true }, { shadow: true }));
  return { json: {
    ...envelope,
    ...input,
    shadow_plan: envelope.shadow_plan || input.shadow_plan || null,
    shadow_mode: true,
    contract_version: 'v3',
    turn_policy: policy,
    v3_policy: policy,
    shadow_started_at_ms: Date.now(),
  } };
});
