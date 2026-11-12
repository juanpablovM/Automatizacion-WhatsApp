// Build Ownership Events: under revision 1.2 only, turn each pending ownership
// change into the exact ownership.taken / ownership.released body to store, or
// the reason it is blocked. Everything goes to Insert Ownership Events as one
// JSON array, so a pass is a single statement.
const ownershipEventsConfig = readCrmEventsConfig($env);
if (!ownershipEventsConfig.enabled || ownershipEventsConfig.errors.length > 0) return [];
if (ownershipEventsConfig.protocol_revision !== '1.2') return [];

const ownershipEvents = items
  .map((item) => item.json ?? {})
  .filter((row) => Number.isSafeInteger(Number(row.change_id)) && Number(row.change_id) > 0)
  .map((row) => {
    const built = buildOwnershipEvent(row, ownershipEventsConfig);
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
