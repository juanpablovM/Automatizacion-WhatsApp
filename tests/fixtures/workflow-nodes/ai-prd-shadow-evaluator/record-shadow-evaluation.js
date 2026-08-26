return items.map((item) => {
  const input = item.json || {};
  const audit = recordShadowEvaluation(input.shadow_plan || input, {
    ok: !input.ai_request_error && !input.ai_fallback_reason,
    error: input.ai_request_error || input.ai_fallback_reason || null,
    duration_ms: Math.max(0, Date.now() - Number(input.shadow_started_at_ms || Date.now())),
  });
  return { json: { ...input, shadow_audit: audit } };
});
