// Build Contact State Events: under revision 1.3 only, turn each contact whose
// state inputs changed since its last check (under this id prefix) into the
// exact contact.state body to store, or the reason it is blocked. progress is
// computed with the policy version the conversation itself uses for that
// phone. Everything goes to Insert Contact State Events as one JSON array, so
// a pass is a single statement, which enqueues only a real change.
const contactStateConfig = readCrmEventsConfig($env);
if (!contactStateConfig.enabled || contactStateConfig.errors.length > 0) return [];
if (contactStateConfig.protocol_revision !== '1.3') return [];

const contactStateEvents = items
  .map((item) => item.json ?? {})
  .filter((row) => Number.isSafeInteger(Number(row.contact_id)) && Number(row.contact_id) > 0)
  .map((row) => buildContactStateEvent(
    row,
    contactStateConfig,
    contactStatePolicyVersion($env, row.phone_number),
  ));
if (contactStateEvents.length === 0) return [];
return [{ json: { events_json: JSON.stringify(contactStateEvents) } }];
