// Build Contact Events: under revision 1.3 only, turn each contact whose phone
// or name changed since its last contact.upserted (under this id prefix) into
// the exact contact.upserted body to store, or the reason it is blocked.
// Everything goes to Insert Contact Events as one JSON array, so a pass is a
// single statement.
const contactEventsConfig = readCrmEventsConfig($env);
if (!contactEventsConfig.enabled || contactEventsConfig.errors.length > 0) return [];
if (contactEventsConfig.protocol_revision !== '1.3') return [];

const contactEvents = items
  .map((item) => item.json ?? {})
  .filter((row) => Number.isSafeInteger(Number(row.contact_id)) && Number(row.contact_id) > 0)
  .map((row) => {
    const built = buildContactUpsertedEvent(row, contactEventsConfig);
    return {
      contact_id: Number(row.contact_id),
      revision: built.revision ?? Number(row.revision),
      event_id: built.event_id,
      body: built.body,
      blocked_reason: built.blocked_reason,
    };
  });
if (contactEvents.length === 0) return [];
return [{ json: { events_json: JSON.stringify(contactEvents) } }];
