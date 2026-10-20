const row = items[0]?.json ?? {};

const configured = (value) => !!value && !String(value).includes('__PENDIENTE__');
const safe = (value, fallback = '') => String(value ?? fallback).trim();
const asInt = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const asObject = (value) => {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value || '{}'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_error) {
    return {};
  }
};
const normalizePhone = (value) => {
  const raw = safe(value);
  if (!raw) return '';

  const compact = raw.replace(/\s+/g, '');
  if (compact.startsWith('+')) {
    const digits = compact.slice(1).replace(/\D/g, '');
    return digits ? `+${digits}` : '';
  }

  const digits = compact.replace(/\D/g, '');
  return digits ? `+${digits}` : '';
};

const leadId = row.lead_id;
const shouldCreateClickup = Boolean(row.should_create_clickup);
const existingClickupTaskId = safe(row.existing_clickup_task_id);
const existingClickupTaskUrl = safe(row.existing_clickup_task_url);
const clickupOperationKey = safe(row.clickup_operation_key, `clickup-task:lead:${leadId}`);
if (!leadId) {
  throw new Error('CRM - ClickUp Sync Lead requiere lead_id');
}

const listId = $env.CLICKUP_LEADS_LIST_ID;
if (!configured(listId)) {
  throw new Error('CLICKUP_LEADS_LIST_ID no esta configurado');
}

const whatsappName = safe(row.whatsapp_name, 'Sin Nombre');
const service = safe(row.service, 'Sin Servicio');
const city = safe(row.city, 'Sin Ciudad');
const requirement = safe(row.requirement, 'Sin requerimiento informado');
const phoneNumber = safe(row.phone_number);
const clickupPhoneNumber = normalizePhone(phoneNumber);
const channel = safe(row.channel, 'whatsapp');
const sourceNumberId = safe(row.source_number_id);
const fullConversation = safe(row.full_conversation);
const advisorOutput = asObject(row.advisor_output_payload);
const diagnostic = asObject(advisorOutput.diagnostic_datos);
const qualification = asObject(row.qualification_context);
const qualificationLabels = {
  modality: 'Modalidad',
  quantity: 'Cantidad',
  measurements: 'Medidas',
  use_case: 'Uso/proyecto',
  terrain: 'Terreno',
  truck_access: 'Acceso camion',
  debris_removal: 'Retiro escombros',
  urgency: 'Urgencia',
  desired_date: 'Fecha deseada',
  photos: 'Fotos',
  customer_type: 'Tipo cliente',
  company: 'Empresa',
  company_rut: 'RUT empresa',
  purchase_order: 'Orden de compra',
  invoice_required: 'Requiere factura',
  address: 'Direccion',
  access_restrictions: 'Restricciones de acceso',
};
const formatQualificationValue = (value) => typeof value === 'boolean' ? (value ? 'Si' : 'No') : safe(value);
const qualificationLines = Object.entries(qualificationLabels)
  .filter(([key]) => qualification[key] !== undefined && qualification[key] !== null && qualification[key] !== '')
  .map(([key, label]) => `${label}: ${formatQualificationValue(qualification[key])}`);
const advisorLines = [
  advisorOutput.lead_class ? 'Clasificacion: ' + advisorOutput.lead_class : null,
  advisorOutput.customer_type ? 'Tipo cliente: ' + advisorOutput.customer_type : null,
  advisorOutput.modality ? 'Modalidad: ' + advisorOutput.modality : null,
  advisorOutput.objection_detected && advisorOutput.objection_detected !== 'none' ? 'Objecion: ' + advisorOutput.objection_detected : null,
  advisorOutput.escalation_area && advisorOutput.escalation_area !== 'none' ? 'Escalamiento: ' + advisorOutput.escalation_area : null,
  advisorOutput.next_best_action ? 'Siguiente accion: ' + advisorOutput.next_best_action : null,
  advisorOutput.executive_summary ? 'Resumen AI: ' + advisorOutput.executive_summary : null,
  diagnostic.pain ? 'Dolor: ' + diagnostic.pain : null,
  diagnostic.scope ? 'Alcance: ' + diagnostic.scope : null,
  diagnostic.timing ? 'Tiempo: ' + diagnostic.timing : null,
  diagnostic.obstacle ? 'Obstaculo: ' + diagnostic.obstacle : null,
  ...qualificationLines,
].filter(Boolean);

const taskName = `${whatsappName} - ${service} - ${city}`;
const description = [
  'Resumen del lead',
  '',
  `Telefono: ${clickupPhoneNumber || phoneNumber || 'No informado'}`,
  `Canal: ${channel || 'whatsapp'}`,
  `Ciudad: ${city}`,
  `Servicio: ${service}`,
  `Requerimiento: ${requirement}`,
  sourceNumberId ? `Numero de Ingreso: ${sourceNumberId}` : null,
  advisorLines.length ? '' : null,
  advisorLines.length ? 'Diagnostico comercial AI' : null,
  ...advisorLines,
].filter(Boolean).join('\n');

const customFields = [];
const pushCustomField = (fieldId, value) => {
  if (!configured(fieldId)) return;
  if (value === undefined || value === null || value === '') return;
  customFields.push({ id: fieldId, value });
};

pushCustomField($env.CLICKUP_CF_WHATSAPP_NAME_ID, whatsappName);
pushCustomField($env.CLICKUP_CF_PHONE_ID, clickupPhoneNumber || phoneNumber);
pushCustomField($env.CLICKUP_CF_SERVICE_ID, service);
pushCustomField($env.CLICKUP_CF_CITY_ID, city);
pushCustomField($env.CLICKUP_CF_REQUIREMENT_ID, requirement);
pushCustomField($env.CLICKUP_CF_INTERNAL_LEAD_ID, String(leadId));
pushCustomField($env.CLICKUP_CF_SOURCE_NUMBER_ID, sourceNumberId || null);
if (configured($env.CLICKUP_CF_CHANNEL_ID) && configured($env.CLICKUP_CF_CHANNEL_OPTION_WHATSAPP_ID)) {
  customFields.push({
    id: $env.CLICKUP_CF_CHANNEL_ID,
    value: $env.CLICKUP_CF_CHANNEL_OPTION_WHATSAPP_ID,
  });
}

const assigneeId = asInt(row.clickup_user_id);
const taskPayload = {
  name: taskName,
  description,
  notify_all: false,
  assignees: assigneeId ? [assigneeId] : [],
  custom_fields: customFields,
};

const commentText = [
  advisorLines.length ? 'Resumen Comercial AI\n\n' + advisorLines.join('\n') : '',
  fullConversation ? 'Conversación Completa Cliente\n\n' + fullConversation : '',
].filter(Boolean).join('\n\n');

return [
  {
    json: {
      lead_id: leadId,
      should_create_clickup: shouldCreateClickup,
      existing_clickup_task_id: existingClickupTaskId || null,
      existing_clickup_task_url: existingClickupTaskUrl || null,
      clickup_operation_key: clickupOperationKey,
      task_name: taskName,
      task_description: description,
      attachments_json: row.attachments_json || [],
      clickup_task_url: `https://api.clickup.com/api/v2/list/${listId}/task`,
      clickup_task_payload: taskPayload,
      comment_text: commentText,
      comment_enabled: Boolean(commentText),
    },
  },
];
