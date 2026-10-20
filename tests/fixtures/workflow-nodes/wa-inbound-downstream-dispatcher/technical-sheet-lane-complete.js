// Task 3c.29: the technical-sheet documents of a delivered v3.1 reply were
// sent (or there were none). Restore the single reply receipt that
// `Outbound Lane Complete` expects and record a short summary of each
// document send: its delivery key, its outcome, and the error of a run that
// failed (Execute Technical Sheet Outbound continues on error, so a failed
// document never blocks the turn; its message row keeps the provider outcome
// for reconciliation).
let receipt = {};
if (typeof $ === 'function') {
  try { receipt = $('Record V3 Delivery Receipt').first().json || {}; }
  catch (_error) { /* Direct fixture callers carry no receipt. */ }
}
const technicalSheetDeliveries = items
  .map((item) => item.json || {})
  .filter((result) => result.delivery_key || result.idempotency_key || result.error)
  .map((result) => ({
    delivery_key: result.delivery_key ?? result.idempotency_key ?? null,
    delivery_status: result.delivery_status ?? result.outbound_dispatch_status ?? null,
    error: result.error ? String(result.error.message ?? result.error) : null,
  }));
return [{ json: { ...receipt, technical_sheet_deliveries: technicalSheetDeliveries } }];
