const row = items[0]?.json ?? {};

const OPERATIONAL_INTENTS = new Set([
  'complaint',
  'warranty_inquiry',
  'payment_proof',
  'invoice_request',
]);

const conversationId = Number(row.conversation_id);
const hasConversation = Number.isSafeInteger(conversationId) && conversationId > 0;
const phoneNumber = String(row.phone_number || '').trim();

const intent = String(row.intent || '').trim();
const isOperational = OPERATIONAL_INTENTS.has(intent);

const shouldWrite = hasConversation && Boolean(phoneNumber) && !isOperational;

const commercialBlocked = Array.isArray(row.commercial_missing_fields)
  && row.commercial_missing_fields.length > 0;

const qualified = Boolean(row.should_create_lead)
  && !commercialBlocked
  && row.confirmation_status === 'confirmed';

const requestedStatus = qualified ? 'qualified' : 'new';

return [
  {
    json: {
      ...row,
      opportunity_scope: {
        conversation_id: conversationId,
        phone_number: phoneNumber,
        source_number_id: Number(row.source_number_id) > 0 ? Number(row.source_number_id) : null,
        external_contact_id: row.external_contact_id || null,
        whatsapp_name: row.whatsapp_name || null,
        service: row.service || null,
        city: row.city || null,
        requirement: row.requirement || null,
        intent_code: intent || null,
        inbound_event_id: Number(row.inbound_event_id) > 0 ? Number(row.inbound_event_id) : null,
      },
      opportunity_write: shouldWrite,
      opportunity_status: requestedStatus,
      opportunity_skipped: !shouldWrite,
    },
  },
];
