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
// D9 (design.md): the flat `quantity`/`measurements` mirror the *primary*
// line item only (design.md D2). The requirement line itemizes every item's
// own quantity and measurements, so they are skipped once the quote has line
// items — task 3c.33 (L3) extends this to a single item, whose requirement is
// now a bullet line too. A historical flat quote (no line_items) keeps them.
const lineItems = Array.isArray(qualification.line_items) ? qualification.line_items : [];
const skippedQualificationKeys = lineItems.length > 0 ? new Set(['quantity', 'measurements']) : new Set();
const qualificationLines = Object.entries(qualificationLabels)
  .filter(([key]) => !skippedQualificationKeys.has(key))
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

// A factory pickup (same rule as prepare-lead-assignment.js) has no city: its
// task says so instead of "Sin Ciudad".
const isPickup = (qualification.service_scope === 'material' && qualification.fulfillment === 'pickup')
  || qualification.modality === 'pickup'
  || safe(row.service) === 'retiro';
const isFactoryPickup = isPickup && !safe(row.city);
const taskName = isFactoryPickup ? `${whatsappName} - retiro en fábrica` : `${whatsappName} - ${service} - ${city}`;
const description = [
  'Resumen del lead',
  '',
  `Telefono: ${clickupPhoneNumber || phoneNumber || 'No informado'}`,
  `Canal: ${channel || 'whatsapp'}`,
  `Ciudad: ${isFactoryPickup ? 'Retiro en fábrica' : city}`,
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

// Hormiglass's "Cotizaciones WhatsApp" list (owner decision 2026-10-14). Each
// field below is opt-in by environment, so a list without it gets nothing new.
const whatsappDigits = (clickupPhoneNumber || '').replace(/\D/g, '');
pushCustomField($env.CLICKUP_CF_WHATSAPP_LINK_ID, whatsappDigits ? `https://wa.me/${whatsappDigits}` : null);
pushCustomField($env.CLICKUP_CF_CONSULTATION_DATE_ID, Date.now());
if (configured($env.CLICKUP_CF_REFERRAL_ID) && configured($env.CLICKUP_CF_REFERRAL_OPTION_WHATSAPP_ID)) {
  customFields.push({ id: $env.CLICKUP_CF_REFERRAL_ID, value: [$env.CLICKUP_CF_REFERRAL_OPTION_WHATSAPP_ID] });
}

// A labels field takes option IDs. The options mapping is {label: optionId};
// a label applies when its first word names something the customer asked for,
// singular or plural ("Baldosa Minvu" -> "Baldosas", "Adoquín" -> "Adoquines").
const wordsOf = (value) => safe(value).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .split(/[^a-z0-9]+/).filter(Boolean);
const sameWord = (left, right) => left === right
  || `${left}s` === right || `${right}s` === left || `${left}es` === right || `${right}es` === left;
const matchingOptionIds = (rawOptions, texts) => {
  const options = asObject(rawOptions);
  const words = texts.flatMap(wordsOf);
  return Object.entries(options)
    .filter(([label, optionId]) => {
      const [firstWord] = wordsOf(label);
      return firstWord && configured(optionId) && words.some((word) => sameWord(word, firstWord));
    })
    .map(([, optionId]) => String(optionId));
};
const pushOptionIds = (fieldId, optionIds) => pushCustomField(fieldId, optionIds.length ? optionIds : null);
// A product naming two labels ("Soleras y Solerillas") keeps only the ones its
// chosen variant names ("Solerilla canto redondo" -> "Solerillas"); with no
// variant, or one naming neither, the item keeps every label it matched.
const productOptions = $env.CLICKUP_CF_PRODUCT_TYPE_OPTIONS_JSON;
const productOptionIds = new Set(lineItems.filter((item) => item && item.product).flatMap((item) => {
  const byProduct = matchingOptionIds(productOptions, [item.product]);
  if (byProduct.length < 2) return byProduct;
  const byVariant = matchingOptionIds(productOptions, [item.variant]).filter((optionId) => byProduct.includes(optionId));
  return byVariant.length ? byVariant : byProduct;
}));
const quotedProducts = lineItems.map((item) => item && item.product).filter(Boolean);
const productTypeIds = matchingOptionIds(productOptions, quotedProducts).filter((optionId) => productOptionIds.has(optionId));
pushOptionIds($env.CLICKUP_CF_PRODUCT_TYPE_ID, productTypeIds);
// A pickup is a product sale: it also takes the "Venta de Producto" label.
const serviceOptions = $env.CLICKUP_CF_SERVICE_TYPE_OPTIONS_JSON;
const productSaleIds = isPickup ? Object.entries(asObject(serviceOptions))
  .filter(([label, optionId]) => wordsOf(label).join(' ') === 'venta de producto' && configured(optionId))
  .map(([, optionId]) => String(optionId)) : [];
const serviceTypeIds = [...new Set([...matchingOptionIds(serviceOptions, [safe(row.service)]), ...productSaleIds])];
pushOptionIds($env.CLICKUP_CF_SERVICE_TYPE_ID, serviceTypeIds);
pushCustomField($env.CLICKUP_CF_CUSTOMER_RUT_ID, safe(qualification.company_rut));
// The tax document follows the customer's invoice answer; no answer, no label.
const taxDocumentOptionId = qualification.invoice_required === true ? $env.CLICKUP_CF_TAX_DOCUMENT_OPTION_FACTURA_ID
  : qualification.invoice_required === false ? $env.CLICKUP_CF_TAX_DOCUMENT_OPTION_BOLETA_ID : null;
pushCustomField($env.CLICKUP_CF_TAX_DOCUMENT_ID, configured(taxDocumentOptionId) ? [String(taxDocumentOptionId)] : null);

const assigneeId = asInt(row.clickup_user_id);
const taskPayload = {
  name: taskName,
  description,
  notify_all: false,
  assignees: assigneeId ? [assigneeId] : [],
  custom_fields: customFields,
};
if (configured($env.CLICKUP_LEAD_INITIAL_STATUS)) {
  taskPayload.status = safe($env.CLICKUP_LEAD_INITIAL_STATUS);
}

const commentText = [
  advisorLines.length ? 'Resumen Comercial AI\n\n' + advisorLines.join('\n') : '',
  fullConversation ? 'Conversación Completa Cliente\n\n' + fullConversation : '',
].filter(Boolean).join('\n\n');

// Quote correction (owner decision 2026-10-14): a re-confirmed reopened quote
// updates its existing task instead of creating another. Only the description,
// "🔍 Solicitud" and "Tipo de producto" change; status, assignees and every
// other field stay as the seller left them. The comment names the assigned
// seller so ClickUp notifies them of the before→after.
const shouldUpdateClickup = Boolean(row.should_update_clickup) && Boolean(existingClickupTaskId);
const oneLine = (value) => safe(value).split('\n').map((line) => line.trim()).filter(Boolean).join('; ');
const correctedFieldIds = new Set([$env.CLICKUP_CF_REQUIREMENT_ID, $env.CLICKUP_CF_PRODUCT_TYPE_ID].filter(configured));
const correction = shouldUpdateClickup ? {
  should_update_clickup: true,
  clickup_correction_operation_key: safe(row.clickup_correction_operation_key),
  clickup_correction_requirement: row.requirement ?? null,
  clickup_update_url: `https://api.clickup.com/api/v2/task/${encodeURIComponent(existingClickupTaskId)}`,
  clickup_update_payload: { description },
  clickup_update_custom_fields: customFields.filter((field) => correctedFieldIds.has(field.id)),
  clickup_correction_comment: {
    comment_text: `✏️ Corrección del cliente: ${oneLine(row.clickup_requirement_before) || 'Sin requerimiento informado'} → ${oneLine(requirement)}`,
    ...(assigneeId ? { assignee: assigneeId } : {}),
    notify_all: false,
  },
} : {};

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
      ...correction,
    },
  },
];
