const configured = (value) => Boolean(value) && !String(value).includes('__PENDIENTE__');

const parseAssignees = (raw, area) => {
  let mapping;
  try {
    mapping = JSON.parse(String(raw || ''));
  } catch (_error) {
    return { error: 'HANDOFF_CLICKUP_ASSIGNEES_JSON_invalid_json', assignees: [] };
  }
  const selected = mapping && typeof mapping === 'object' ? mapping[area] : null;
  const values = Array.isArray(selected) ? selected : [selected];
  const assignees = values
    .map((value) => Number(value))
    .filter((value) => Number.isSafeInteger(value) && value > 0);
  return assignees.length
    ? { error: null, assignees: [...new Set(assignees)] }
    : { error: `HANDOFF_CLICKUP_ASSIGNEES_JSON_missing_area:${area}`, assignees: [] };
};

const prepareHandoffClickup = (row, env = {}) => {
  const area = String(row.area || '').trim();
  const configErrors = [];
  if (!configured(env.CLICKUP_API_TOKEN)) configErrors.push('CLICKUP_API_TOKEN_missing');
  if (!configured(env.CLICKUP_LIST_ID)) configErrors.push('CLICKUP_LIST_ID_missing');
  const assignment = area === 'sales'
    ? parseAssignees(env.HANDOFF_CLICKUP_ASSIGNEES_JSON, area)
    : { error: `HANDOFF_CLICKUP_AREA_unsupported:${area || 'missing'}`, assignees: [] };
  if (assignment.error) configErrors.push(assignment.error);

  const handoffId = Number(row.handoff_id);
  if (!Number.isSafeInteger(handoffId) || handoffId <= 0) configErrors.push('handoff_id_invalid');
  const operationKey = String(row.operation_key || '').trim();
  if (!operationKey) configErrors.push('operation_key_missing');

  const description = [
    `Handoff interno #${handoffId || 'unknown'}`,
    `Área: ${row.area_label || area || 'No informada'}`,
    `Responsable: ${row.responsable || 'No informado'}`,
    `Prioridad: ${row.prioridad || 'No informada'}`,
    `Motivo: ${row.motivo || 'No informado'}`,
    `Cliente: ${row.phone_number || 'No informado'}`,
    `Conversación: ${row.conversation_id || 'No informada'}`,
    row.escalation_reason ? `Detalle: ${row.escalation_reason}` : null,
    `Operation key: ${operationKey}`,
  ].filter(Boolean).join('\n');

  return {
    ...row,
    clickup_config_error: configErrors.length ? configErrors.join(',') : null,
    should_dispatch_clickup: configErrors.length === 0,
    clickup_url: configErrors.length ? null : `https://api.clickup.com/api/v2/list/${encodeURIComponent(env.CLICKUP_LIST_ID)}/task`,
    clickup_payload: configErrors.length ? null : {
      name: `[HANDOFF #${handoffId}] ${row.area_label || area} - ${row.motivo || 'escalamiento'}`,
      description,
      assignees: assignment.assignees,
      priority: row.prioridad === 'urgente' ? 1 : row.prioridad === 'alta' ? 2 : 3,
    },
  };
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { configured, parseAssignees, prepareHandoffClickup };
}

if (typeof $json !== 'undefined') {
  return { json: prepareHandoffClickup($json ?? {}, typeof $env !== 'undefined' ? $env : {}) };
}
