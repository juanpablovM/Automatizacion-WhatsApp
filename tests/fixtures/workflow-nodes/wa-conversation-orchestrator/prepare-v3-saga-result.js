// Rejoin the v3 saga with the turn context so the lane can emit the same
// downstream contract the legacy lane emits.
//
// Why this is needed at all: every step of the v3 saga is a Postgres node, and
// an n8n Postgres node REPLACES the item with its query result. By the time the
// lane reaches here the original turn row — phone_number, processing_token,
// inbound_event_id and the rest of the 77 fields Prepare Conversation Output
// reads — is long gone, replaced by ledger rows. The previous version of this
// node was `{ ...item.json, v3_saga: true }`, a passthrough of ledger columns
// with no outgoing connection, so a v3 turn reached the dispatcher with no
// dispatch contract at all: no reply, no handoff, no follow-up.
//
// The context is read back from `Merge AI Assistance`, the last node before the
// contract route splits legacy from v3, which still holds the complete turn row.
// The saga outcome is layered on top so ledger state wins where both define a
// field.

const asObject = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});

const turnContext = () => {
  // $() is only available inside n8n. Outside it (unit tests) the caller passes
  // the context explicitly, so the node stays testable without a live engine.
  if (typeof $ === 'function') {
    try {
      return asObject($('Merge AI Assistance').first().json);
    } catch (_error) {
      return {};
    }
  }
  return {};
};

const prepareV3SagaResult = (sagaItems, context) => {
  const base = asObject(context);
  const items = Array.isArray(sagaItems) ? sagaItems : [];
  if (!items.length) {
    // A saga that produced no row still owes the dispatcher a turn: emitting
    // nothing here is how the lane used to lose items silently.
    return [{ json: { ...base, v3_saga: true, v3_saga_empty: true } }];
  }
  return items.map((item) => {
    const saga = asObject(item.json ?? item);
    const rawPayload = asObject(saga.raw_payload);
    return {
      json: {
        ...base,
        ...saga,
        response_text: saga.text_body ?? base.response_text ?? null,
        response_kind: 'v3_advisor_reply',
        message_id: saga.delivery_message_id ?? base.message_id ?? null,
        delivery_key: saga.delivery_key ?? null,
        decision_id: saga.decision_id ?? null,
        reply_sha256: saga.reply_sha256 ?? rawPayload.reply_sha256 ?? null,
        should_create_lead: false,
        should_escalate: false,
        v3_saga: true,
      },
    };
  });
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { prepareV3SagaResult, turnContext };
}

if (typeof items !== 'undefined') {
  return prepareV3SagaResult(items, turnContext());
}
