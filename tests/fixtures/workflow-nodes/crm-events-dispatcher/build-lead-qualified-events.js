// Build Lead Qualified Events: one item per candidate lead, either the exact
// body to store in crm_events or the reason the lead is blocked. The body is
// built once here and stored; delivery never rebuilds it.
const leadEventsConfig = readCrmEventsConfig($env);
if (!leadEventsConfig.enabled || leadEventsConfig.errors.length > 0) return [];

return items
  .map((item) => item.json ?? {})
  .filter((row) => Number.isSafeInteger(Number(row.lead_id)) && Number(row.lead_id) > 0)
  .map((row) => {
    const built = buildLeadQualifiedEvent(row, leadEventsConfig);
    return { json: {
      lead_id: Number(row.lead_id),
      revision: built.revision ?? Number(row.revision),
      event_id: built.event_id,
      conversation_id: built.conversation_id,
      body: built.body,
      // The raw stored requirement (not the fallback text): Insert Lead
      // Qualified Event compares it with the lead under a row lock, and a
      // correction is a requirement that differs from the last one enqueued.
      requirement_snapshot: String(row.requirement ?? ''),
      blocked_reason: built.blocked_reason,
      // Revision 1.2 detects corrections by record, not by requirement: the
      // hash of the business fields this body carries, and the source hash the
      // candidate was selected with (Insert re-checks it under the row lock).
      // Both stay null under 1.1, which keeps the requirement rule.
      record_hash: built.record_hash ?? null,
      source_hash: leadEventsConfig.protocol_revision === '1.2' && row.crm_source_hash ? String(row.crm_source_hash) : null,
    } };
  });
