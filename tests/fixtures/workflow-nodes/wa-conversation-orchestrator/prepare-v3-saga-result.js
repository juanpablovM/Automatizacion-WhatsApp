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
    const effectReceipts = Array.isArray(saga.effect_receipt_refs)
      ? saga.effect_receipt_refs
      : [];
    const leadReceipt = effectReceipts.find((receipt) => (
      receipt?.version === 'v3_effect_receipt/v1'
      && receipt?.effect_type === 'create_lead'
      && receipt?.status === 'succeeded'
      && Number(receipt?.lead_id) > 0
    ));
    const committedLeadId = Number(saga.lead_id);
    const resumeLeadPipeline = Boolean(
      leadReceipt
      && Number.isSafeInteger(committedLeadId)
      && committedLeadId > 0
      && String(leadReceipt.lead_id) === String(saga.lead_id),
    );
    const qualificationContext = resumeLeadPipeline
      ? asObject(saga.qualification_context)
      : asObject(saga.v3_persisted_qualification_context ?? base.qualification_context);
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
        lead_id: resumeLeadPipeline ? committedLeadId : (saga.lead_id ?? base.lead_id ?? null),
        service: resumeLeadPipeline ? saga.service : base.service,
        city: resumeLeadPipeline ? saga.city : base.city,
        requirement: resumeLeadPipeline ? saga.requirement : base.requirement,
        qualification_context: qualificationContext,
        qualification_context_json: JSON.stringify(qualificationContext),
        commercial_missing_fields: resumeLeadPipeline ? [] : base.commercial_missing_fields,
        is_partial: resumeLeadPipeline ? false : Boolean(base.is_partial),
        conversation_status_code: resumeLeadPipeline
          ? 'handed_to_sales'
          : (saga.v3_persisted_conversation_status_code
            ?? saga.conversation_status_code_1
            ?? saga.conversation_status_code
            ?? base.conversation_status_code),
        current_step: resumeLeadPipeline
          ? 'complete'
          : (saga.v3_persisted_current_step
            ?? saga.current_step_1
            ?? saga.current_step
            ?? base.current_step),
        pending_question_key: resumeLeadPipeline
          ? null
          : (Object.prototype.hasOwnProperty.call(saga, 'v3_persisted_pending_question_key')
            ? saga.v3_persisted_pending_question_key
            : (Object.prototype.hasOwnProperty.call(saga, 'pending_question_key_1')
            ? saga.pending_question_key_1
            : (Object.prototype.hasOwnProperty.call(saga, 'pending_question_key')
              ? saga.pending_question_key
              : base.pending_question_key))),
        // The canonical v3 effect already created and assigned the lead. This
        // flag deliberately re-enters the existing idempotent lead lane so its
        // remaining responsibilities — ClickUp sync, seller notification and
        // verified customer handoff — are not silently skipped.
        should_create_lead: resumeLeadPipeline,
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
