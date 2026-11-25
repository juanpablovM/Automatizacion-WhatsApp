// Build Handoff Events: under revision 1.2 with CRM_EVENTS_HANDOFFS_ENABLED
// only, turn each routed handoff into the exact handoff.created body to store,
// or the reason it is blocked. The routing key the body carries goes along, so
// Insert Handoff Events can check it is still the handoff's routing. Everything
// goes to Insert Handoff Events as one JSON array, so a pass is one statement.
const handoffEventsConfig = readCrmEventsConfig($env);
if (!handoffEventsConfig.enabled || handoffEventsConfig.errors.length > 0) return [];
if (!handoffEventsConfig.handoffs_enabled) return [];

const handoffEvents = items
  .map((item) => item.json ?? {})
  .filter((row) => Number.isSafeInteger(Number(row.handoff_id)) && Number(row.handoff_id) > 0)
  .map((row) => {
    const built = buildHandoffCreatedEvent(row, handoffEventsConfig);
    return {
      handoff_id: Number(row.handoff_id),
      revision: built.revision ?? Number(row.revision),
      event_id: built.event_id,
      conversation_id: built.conversation_id,
      body: built.body,
      blocked_reason: built.blocked_reason,
      crm_opportunity_id: row.crm_opportunity_id ? String(row.crm_opportunity_id) : null,
      crm_seller_id: row.crm_seller_id ? String(row.crm_seller_id) : null,
    };
  });
if (handoffEvents.length === 0) return [];
return [{ json: { events_json: JSON.stringify(handoffEvents) } }];
