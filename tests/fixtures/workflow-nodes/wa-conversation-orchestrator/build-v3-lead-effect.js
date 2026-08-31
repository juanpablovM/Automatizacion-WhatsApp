const buildV3LeadEffect = (row) => ({
  ...row,
  operation_key: row.operation_key,
  source_number_id: row.source_number_id,
  phone_number: row.phone_number,
  external_contact_id: row.external_contact_id ?? null,
  whatsapp_name: row.whatsapp_name ?? null,
  service: row.qualification_context?.service ?? null,
  city: row.qualification_context?.city ?? null,
  requirement: row.qualification_context?.requirement ?? null,
  is_partial: false,
  conversation_id: row.conversation_id,
  qualification_context: row.qualification_context ?? {},
  qualification_context_json: JSON.stringify(row.qualification_context ?? {}),
  commercial_missing_fields: [],
});

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { buildV3LeadEffect };
}

if (typeof items !== 'undefined') {
  return items.map((item) => ({ json: buildV3LeadEffect(item.json ?? {}) }));
}
