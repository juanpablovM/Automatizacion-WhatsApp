const row = items[0]?.json ?? {};

const pickValue = (...values) => {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' && value.trim() === '') continue;
    return value;
  }
  return null;
};

const countCompleted = (payload) => ['service', 'city', 'requirement'].filter((key) => !!String(payload[key] || '').trim()).length;

const lead = {
  previous_lead_id: row.previous_lead_id || null,
  source_number_id: pickValue(row.source_number_id, row.previous_source_number_id),
  external_contact_id: pickValue(row.external_contact_id, row.previous_external_contact_id),
  whatsapp_name: pickValue(row.whatsapp_name, row.previous_whatsapp_name),
  phone_number: row.phone_number,
  service: pickValue(row.service),
  city: pickValue(row.city),
  requirement: pickValue(row.requirement),
  qualification_context: row.qualification_context && typeof row.qualification_context === 'object'
    ? row.qualification_context
    : {},
  conversation_id: row.conversation_id || null,
};

if (!lead.conversation_id) {
  throw new Error('No se puede crear lead sin conversation_id estable');
}

const completedCount = countCompleted(lead);
const commercialMissingFields = Array.isArray(row.commercial_missing_fields)
  ? row.commercial_missing_fields.filter((field) => String(field || '').trim().length > 0)
  : [];

if (completedCount < 3) {
  throw new Error('No se puede crear lead: faltan servicio, ciudad o requerimiento concreto confirmado');
}
if (commercialMissingFields.length > 0) {
  const validationErrors = {
    reason: 'commercial_gate_blocked',
    profile: row.commercial_policy_profile || null,
    missing_fields: commercialMissingFields,
    message: `No se puede crear lead: campos comerciales obligatorios del PRD pendientes [${commercialMissingFields.join(', ')}]. Confirmacion pendiente; el orquestador debe preguntarlos antes.`,
  };
  throw new Error('BLOCKED|' + JSON.stringify(validationErrors));
}

const isPartial = false;
const leadStatusCode = 'qualified_complete';
const rotationKey = lead.source_number_id ? 'whatsapp:' + lead.source_number_id : 'whatsapp:default';

return [
  {
    json: {
      ...lead,
      is_partial: isPartial,
      is_qualified: true,
      lead_status_code: leadStatusCode,
      rotation_key: rotationKey,
      completed_fields_count: completedCount,
    },
  },
];

