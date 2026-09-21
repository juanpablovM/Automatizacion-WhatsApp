// PostgreSQL receipt nodes replace the item. Restore the single claimed event
// context before merging completion lanes so the strict inbox token survives.
let dispatchContext = {};
if (typeof $ === 'function') {
  try { dispatchContext = $('Normalize Durable Dispatch').first().json || {}; }
  catch (_error) { /* Direct fixture callers carry their own context. */ }
}
return items.map((item) => {
  const receipt = item.json || {};
  return { json: {
    ...dispatchContext, ...receipt,
    inbound_event_id: dispatchContext.inbound_event_id ?? receipt.inbound_event_id ?? null,
    processing_token: dispatchContext.processing_token ?? receipt.processing_token ?? null,
    outbound_lane_complete: true,
  } };
});
