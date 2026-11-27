// Build Backfill Events (1.3 backfill, U8): under revision 1.3 only, turn each
// work item of Select Backfill Candidates into the exact body to store, or the
// reason it is blocked. Kinds: lead (historical lead.qualified with outcome
// and closed_at), handoff (historical handoff.created; resolved_at when it is
// resolved, else a live one with its routing key), message (historical
// message.new), holder (ownership.taken of the current chat holder with the
// proposed contact counter) and complete (the contact's backfill is done).
// Everything goes to Insert Backfill Events as one JSON array, so a pass is a
// single statement.
const backfillConfig = readCrmEventsConfig($env);
if (!backfillConfig.enabled || backfillConfig.errors.length > 0) return [];
if (backfillConfig.protocol_revision !== '1.3') return [];

const backfillText = (value) => (value === null || value === undefined || value === '' ? null : String(value));
const backfillBuild = (kind, payload) => {
  if (kind === 'lead') {
    return buildLeadQualifiedEvent(payload, backfillConfig, {
      outcome: payload.outcome, closed_at: backfillText(payload.closed_at),
    });
  }
  if (kind === 'handoff') {
    return buildHandoffCreatedEvent(payload, backfillConfig, { resolved_at: backfillText(payload.resolved_at) });
  }
  if (kind === 'message') return buildMessageNewEvent(payload, backfillConfig, { historical: true });
  if (kind === 'holder') return buildOwnershipEvent(payload, backfillConfig);
  return { blocked_reason: null, event_id: null, conversation_id: null, body: null };
};

const backfillEvents = items
  .map((item) => item.json ?? {})
  .filter((row) => ['lead', 'handoff', 'message', 'holder', 'complete'].includes(row.kind)
    && Number.isSafeInteger(Number(row.contact_id)) && Number(row.contact_id) > 0
    && Number.isSafeInteger(Number(row.entity_id)) && Number(row.entity_id) > 0)
  .map((row) => {
    const payload = row.payload && typeof row.payload === 'object' ? row.payload : {};
    const built = backfillBuild(row.kind, payload);
    return { row, payload, built };
  })
  // A pending contact always has its contact.upserted, so nothing is deferred;
  // kept as a guard.
  .filter(({ built }) => !isCrmEventDeferred(built))
  .map(({ row, payload, built }) => ({
    kind: row.kind,
    contact_id: Number(row.contact_id),
    entity_id: Number(row.entity_id),
    id_prefix: backfillConfig.id_prefix,
    event_id: built.event_id ?? null,
    event_type: built.body ? JSON.parse(built.body).type : null,
    conversation_id: built.conversation_id ?? null,
    revision: row.kind === 'lead' || row.kind === 'handoff' ? Number(built.revision ?? payload.revision) : null,
    body: built.body ?? null,
    blocked_reason: built.blocked_reason ?? null,
    record_hash: row.kind === 'lead' ? built.record_hash ?? null : null,
    source_hash: row.kind === 'lead' ? backfillText(payload.crm_source_hash) : null,
    requirement: row.kind === 'lead' ? String(payload.requirement ?? '') : null,
    // An open handoff is live: Insert re-checks its stored routing, as 10 does.
    routed: row.kind === 'handoff' ? !backfillText(payload.resolved_at) : null,
    crm_opportunity_id: row.kind === 'handoff' ? backfillText(payload.crm_opportunity_id) : null,
    crm_seller_id: row.kind === 'handoff' ? backfillText(payload.crm_seller_id) : null,
    change_id: row.kind === 'holder' ? Number(payload.change_id) : null,
    contact_version: row.kind === 'holder' ? Number(payload.contact_version) : null,
  }));
if (backfillEvents.length === 0) return [];
return [{ json: { events_json: JSON.stringify(backfillEvents) } }];
