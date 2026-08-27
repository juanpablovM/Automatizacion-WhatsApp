const normalizeFollowUpDelivery = (origin, outbound) => {
  const deliveryStatus = String(outbound?.delivery_status || outbound?.outbound_dispatch_status || '').trim();
  const errorMessage = String(outbound?.error?.message || outbound?.message || '').trim();
  let outcome = 'unknown';
  if (deliveryStatus === 'sent' || deliveryStatus === 'already_sent') outcome = 'sent';
  else if (deliveryStatus === 'failed') outcome = 'failed';
  else if (!deliveryStatus && /requiere|configurad|missing|required/i.test(errorMessage)) outcome = 'failed';

  return {
    ...origin,
    outbound_delivery_status: deliveryStatus || 'unknown',
    outbound_message_id: outbound?.message_id || null,
    follow_up_outcome: outcome,
    follow_up_error: outcome === 'sent' ? null : (errorMessage || `outbound_${deliveryStatus || 'unknown'}`),
  };
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { normalizeFollowUpDelivery };
}

if (typeof items !== 'undefined') {
  let origins = [];
  try { origins = $('Prepare Follow-Up Message').all().map((item) => item.json || {}); } catch (_error) { origins = []; }
  return items.map((item, index) => ({
    json: normalizeFollowUpDelivery(origins[index] || {}, item.json || {}),
  }));
}
