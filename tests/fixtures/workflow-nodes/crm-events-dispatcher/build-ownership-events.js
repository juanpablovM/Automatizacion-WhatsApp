// Build Ownership Events: under revision 1.2 or 1.3, turn each pending ownership
// change into the exact ownership.taken / ownership.released body to store, or
// the reason it is blocked. Everything goes to Insert Ownership Events as one
// JSON array, so a pass is a single statement. Under 1.3 a change whose
// contact has no contact.upserted yet is dropped.
const ownershipEventsConfig = readCrmEventsConfig($env);
if (!ownershipEventsConfig.enabled || ownershipEventsConfig.errors.length > 0) return [];
if (!['1.2', '1.3'].includes(ownershipEventsConfig.protocol_revision)) return [];

const ownershipEvents = items
  .map((item) => item.json ?? {})
  .filter((row) => Number.isSafeInteger(Number(row.change_id)) && Number(row.change_id) > 0)
  .map((row) => ({ row, built: buildOwnershipEvent(row, ownershipEventsConfig) }))
  .filter(({ built }) => !isCrmEventDeferred(built))
  .map(({ row, built }) => {
    return {
      change_id: Number(row.change_id),
      event_id: built.event_id,
      conversation_id: built.conversation_id,
      event_type: built.body ? JSON.parse(built.body).type : null,
      body: built.body,
      blocked_reason: built.blocked_reason,
    };
  });
if (ownershipEvents.length === 0) return [];
return [{ json: { events_json: JSON.stringify(ownershipEvents) } }];
