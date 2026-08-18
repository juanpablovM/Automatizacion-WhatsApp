const assigneeError = (raw, memberships) => {
  let mapping;
  try { mapping = JSON.parse(String(raw || '')); } catch (_error) { return 'HANDOFF_CLICKUP_ASSIGNEES_JSON_invalid_json'; }
  const ids = Array.isArray(mapping?.sales) ? mapping.sales : [mapping?.sales];
  if (!ids.some((id) => Number.isSafeInteger(Number(id)) && Number(id) > 0)) return 'HANDOFF_CLICKUP_ASSIGNEES_JSON_missing_area:sales';
  for (const id of ids) {
    const member = memberships.find((value) => Number(value.id) === Number(id));
    if (!member || !member.active) return `HANDOFF_CLICKUP_ASSIGNEE_inactive:${id}`;
    if (!member.assignable) return `HANDOFF_CLICKUP_ASSIGNEE_unassignable:${id}`;
  }
  return null;
};

const prepareValidatedSalesHandoff = (row, env, memberships) => {
  const error = assigneeError(env.HANDOFF_CLICKUP_ASSIGNEES_JSON, memberships);
  return error ? { ...row, should_dispatch_clickup: false, clickup_config_error: error } : { ...row, should_dispatch_clickup: true, clickup_config_error: null };
};

const reconcileExactMarker = (tasks, operationKey) => {
  const matches = tasks.filter((task) => String(task.description || '').includes(`Operation key: ${operationKey}`));
  return matches.length === 1 ? { outcome: 'succeeded' } : matches.length > 1 ? { outcome: 'duplicate_incident' } : { outcome: 'reconciliation_required' };
};

const consumeNoEffectAuthorization = (stored, expected) => {
  const bound = stored && !stored.consumed && ['operation_key', 'list_id', 'search_horizon', 'evidence_revision'].every((key) => stored[key] === expected[key]);
  return { allow_post: bound, authorization: bound ? { ...stored, consumed: true } : stored };
};

module.exports = { prepareValidatedSalesHandoff, reconcileExactMarker, consumeNoEffectAuthorization };
