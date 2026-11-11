// Build Message Events: under revision 1.2 only, turn each candidate message
// into the exact message.new body to store, or the reason it is blocked (for
// example a seller reply whose seller has no crm_user_id). Everything goes to
// Insert Message Events as one JSON array, so a pass is a single statement.
const messageEventsConfig = readCrmEventsConfig($env);
if (!messageEventsConfig.enabled || messageEventsConfig.errors.length > 0) return [];
if (messageEventsConfig.protocol_revision !== '1.2') return [];

const messageEvents = items
  .map((item) => item.json ?? {})
  .filter((row) => Number.isSafeInteger(Number(row.message_id)) && Number(row.message_id) > 0)
  .map((row) => {
    const built = buildMessageNewEvent(row, messageEventsConfig);
    return {
      message_id: Number(row.message_id),
      event_id: built.event_id,
      conversation_id: built.conversation_id,
      body: built.body,
      blocked_reason: built.blocked_reason,
    };
  });
if (messageEvents.length === 0) return [];
return [{ json: { events_json: JSON.stringify(messageEvents) } }];
