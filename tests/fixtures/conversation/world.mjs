// =============================================================================
// Simulated conversation world.
// -----------------------------------------------------------------------------
// Chaining turns is not a matter of feeding a turn's output back as the next
// turn's input. Between two turns sits `07_persist_conversation_state.sql` and
// then `01_load_active_context.sql`, and that round trip renames fields, derives
// others from the clock, rebuilds the message history and allocates new rows.
// This module owns that round trip so a scenario only has to say what the
// customer sent and when.
//
// Each divergence from a naive output -> input copy is marked [Dn] below and
// explained where it is applied.
// =============================================================================

const RECENT_WINDOW_HOURS = 48; // 01_load_active_context.sql:304
const REENGAGEMENT_WINDOW_DAYS = 30; // 01_load_active_context.sql:318
const ACTIVE_STATUSES = new Set(['active', 'waiting_user', 'out_of_flow']); // :312
const RECENT_MESSAGE_LIMIT = 8; // :145-170

const hoursBetween = (from, to) => (to.getTime() - from.getTime()) / 3_600_000;

const parseJson = (value, fallback) => {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
};

export const createWorld = ({
  phoneNumber = 'scenario-contact',
  sourceNumberId = 1,
  instanceName = 'principal',
  whatsappName = 'Cliente Escenario',
} = {}, given = {}) => {
  const world = {
    contact: { phoneNumber, sourceNumberId, instanceName, whatsappName },
    conversation: null,
    lead: null,
    messages: [],
    // [D7] The reset marker truncates the rebuilt history, the way the load
    // query cuts at the last audit whose metadata.reset_conversation_lead is
    // true.
    historyResetAt: null,
    lastInboundAt: null,
    sequence: { conversation: 0, lead: 0, inboundEvent: 0, message: 0 },
  };

  // A scenario may start mid-history: a customer who already has a lead, or a
  // conversation left waiting. Seeding the world is how a scenario states that
  // precondition without replaying the turns that produced it.
  if (given.lead) {
    world.sequence.lead += 1;
    world.lead = { id: world.sequence.lead, whatsappName, ...given.lead };
  }
  if (given.conversation) {
    world.sequence.conversation += 1;
    world.conversation = {
      id: world.sequence.conversation,
      qualificationContext: {},
      commercialQuestionRetry: 0,
      leadId: world.lead?.id ?? null,
      ...given.conversation,
    };
  }
  if (given.messages) {
    world.messages = given.messages.map((message) => ({
      direction: message.role === 'user' ? 'incoming' : 'outgoing',
      text: message.content,
      at: new Date(message.at ?? given.lastInboundAt),
      delivered: message.delivered !== false,
    }));
  }
  if (given.lastInboundAt) world.lastInboundAt = new Date(given.lastInboundAt);

  return world;
};

// Rebuilds `recent_messages` the way the load query does, rather than carrying
// the previous turn's array forward: apply drops the field entirely, and the
// query re-derives it from the `messages` table under its own conditions.
const rebuildRecentMessages = (world, now) => {
  const conversation = world.conversation;
  if (!conversation) return [];
  if (!ACTIVE_STATUSES.has(conversation.status)) return []; // :166
  if (!world.lastInboundAt) return [];
  if (hoursBetween(world.lastInboundAt, now) >= RECENT_WINDOW_HOURS) return []; // :164
  const cutoff = world.historyResetAt ? world.historyResetAt.getTime() : 0;
  return world.messages
    .filter((message) => message.at.getTime() >= cutoff)
    .filter((message) => message.direction === 'incoming' || message.delivered)
    .slice(-RECENT_MESSAGE_LIMIT)
    .map((message) => ({
      role: message.direction === 'incoming' ? 'user' : 'assistant',
      content: message.text,
    }));
};

const lastOutgoing = (world) => {
  for (let index = world.messages.length - 1; index >= 0; index -= 1) {
    const message = world.messages[index];
    if (message.direction === 'outgoing' && message.delivered) return message;
  }
  return null;
};

/**
 * Builds the row the orchestrator receives for one inbound message, the way
 * `01_load_active_context.sql` would return it at `at`.
 */
export const inputRowFor = (world, turn) => {
  const now = new Date(turn.at);
  const conversation = world.conversation;
  const lead = world.lead;
  world.sequence.inboundEvent += 1;

  // [D9] Every temporal flag is derived from the clock against the PREVIOUS
  // inbound, never carried from the last output.
  const elapsedInboundHours = world.lastInboundAt ? hoursBetween(world.lastInboundAt, now) : null;
  const hasConversation = Boolean(conversation);
  const isRecent = hasConversation && elapsedInboundHours !== null
    && elapsedInboundHours < RECENT_WINDOW_HOURS;
  const isStale = hasConversation && elapsedInboundHours !== null
    && elapsedInboundHours >= RECENT_WINDOW_HOURS;
  const isReengagement = isStale
    && elapsedInboundHours < REENGAGEMENT_WINDOW_DAYS * 24;
  const hasActive = isRecent && ACTIVE_STATUSES.has(conversation.status);

  const outgoing = lastOutgoing(world);

  const row = {
    // Inbound message. [D12] The load query names these `input_*` and
    // `file_size_raw`; the node output names them differently, so a blind copy
    // of a previous output would silently drop every one of them.
    phone_number: world.contact.phoneNumber,
    input_source_number_id: world.contact.sourceNumberId,
    instance_name: world.contact.instanceName,
    input_whatsapp_name: world.contact.whatsappName,
    inbound_event_id: world.sequence.inboundEvent,
    processing_token: `scenario-token-${world.sequence.inboundEvent}`,
    input_external_contact_id: world.contact.phoneNumber,
    input_external_message_id: `scenario-msg-${world.sequence.inboundEvent}`,
    input_external_timestamp: now.toISOString(),
    text_body: turn.inbound?.text ?? '',
    message_type: turn.inbound?.messageType ?? 'text',
    attachment_type: turn.inbound?.attachmentType ?? null,
    mime_type: turn.inbound?.mimeType ?? null,
    filename: turn.inbound?.filename ?? null,
    external_media_id: turn.inbound?.externalMediaId ?? null,
    external_url: turn.inbound?.externalUrl ?? null,
    sha256: turn.inbound?.sha256 ?? null,
    file_size_raw: turn.inbound?.fileSize ?? null,
    raw_payload_json: turn.inbound?.rawPayloadJson ?? '{}',

    // Conversation state.
    conversation_id: conversation?.id ?? null,
    target_conversation_id: conversation?.id ?? null,
    conversation_status_code: conversation?.status,
    current_step: conversation?.currentStep ?? '',
    state_current_step: conversation?.stateCurrentStep ?? '',
    state_service: conversation?.service ?? null,
    state_city: conversation?.city ?? null,
    state_requirement: conversation?.requirement ?? null,
    qualification_context: conversation?.qualificationContext ?? {},
    pending_question_key: conversation?.pendingQuestionKey ?? null,
    previous_commercial_pending_question_key: conversation?.commercialPendingQuestionKey ?? null,
    previous_commercial_question_retry: conversation?.commercialQuestionRetry ?? 0,
    lead_id: conversation?.leadId ?? null,

    // Derived flags.
    has_existing_conversation: hasConversation,
    has_active_conversation: hasActive,
    is_recent_conversation: isRecent,
    is_stale_context: isStale,
    is_reengagement: isReengagement,
    elapsed_hours_since_last_inbound: elapsedInboundHours,

    // [D8] The 6h terminal-reply cooldown reads only these two.
    last_outgoing_text: outgoing?.text ?? '',
    elapsed_hours_since_last_outbound: outgoing ? hoursBetween(outgoing.at, now) : null,

    // [D7] Rebuilt, never carried.
    recent_messages: rebuildRecentMessages(world, now),

    // [D4][D5] `previous_*` come from the leads table; `last_known_*` are
    // COALESCE(state_*, lead.*). The node output's own `previous_lead_id` is
    // null unless it resumed previous context, so it must not be fed back.
    previous_lead_id: lead?.id ?? null,
    previous_whatsapp_name: lead?.whatsappName ?? null,
    previous_service: lead?.service ?? null,
    previous_city: lead?.city ?? null,
    previous_requirement: lead?.requirement ?? null,
    last_known_service: conversation?.service ?? lead?.service ?? null,
    last_known_city: conversation?.city ?? lead?.city ?? null,
    last_known_requirement: conversation?.requirement ?? lead?.requirement ?? null,

    // [D10] Ownership is external state; a scenario authors it explicitly.
    bot_suppressed: turn.ownership?.botSuppressed ?? false,
    human_response_due_at: turn.ownership?.humanResponseDueAt ?? null,
    human_arbitration_required: turn.ownership?.humanArbitrationRequired ?? false,
    ownership_id: turn.ownership?.ownershipId ?? null,
    ownership_lead_id: turn.ownership?.ownershipLeadId ?? null,

    // [D11] Route metadata is recomputed per turn by the upstream node.
    contract_route: turn.route?.contractRoute ?? 'v3',
    contract_version: turn.route?.contractVersion ?? 'v3',
    contract_mode: turn.route?.contractMode ?? 'enforce',
    route_mode: turn.route?.routeMode ?? 'default',
    route_rule_id: turn.route?.routeRuleId ?? null,
    v3_grounding: turn.route?.grounding ?? null,
  };

  // [D6] `escalation_reason` is never selected by the load query, so the next
  // turn always sees it undefined. Feeding the real reason back would test more
  // than production does, so it is deliberately absent from this row.
  return row;
};

/**
 * Applies one turn's result the way the persist query would, so the next call
 * to `inputRowFor` reads what the database would hold.
 */
export const commitTurn = (world, turn, applied) => {
  const now = new Date(turn.at);
  const metadata = parseJson(applied.metadata_json, {});
  const afterPayload = parseJson(applied.after_payload_json, {});
  const resetLead = Boolean(applied.reset_conversation_lead);

  if (!world.conversation || resetLead) {
    // [D2] A reset nulls the ids in the output to signal "insert a row"; the
    // persist query then creates one and the next load returns its new id.
    // Carrying the null forward would make the next turn look like a first
    // interaction.
    world.sequence.conversation += 1;
    world.conversation = { id: world.sequence.conversation };
    if (resetLead) {
      world.historyResetAt = now; // [D7]
      world.lead = null;
    }
  }

  const conversation = world.conversation;
  // [D1] Apply emits a bare step on turns where it accepts nothing, while the
  // encoded step is what carries the inline state payload. Persist whichever
  // the node produced, and keep the fields separately, exactly as production
  // does: state survives through state_* even when the step is bare.
  conversation.currentStep = applied.current_step ?? '';
  conversation.stateCurrentStep = afterPayload.current_step ?? applied.current_step ?? '';
  conversation.status = applied.conversation_status_code;
  conversation.service = applied.service || null;
  conversation.city = applied.city || null;
  conversation.requirement = applied.requirement || null;
  conversation.qualificationContext = parseJson(applied.qualification_context_json, applied.qualification_context ?? {});
  conversation.pendingQuestionKey = applied.pending_question_key ?? null;
  conversation.commercialPendingQuestionKey = metadata.pending_question_key ?? null;
  conversation.commercialQuestionRetry = metadata.commercial_question_retry ?? 0;

  // [D3] Neither node creates a lead; the effect runs out of band and the lead
  // reappears on later turns through the leads table.
  if (applied.should_create_lead) {
    world.sequence.lead += 1;
    world.lead = {
      id: world.sequence.lead,
      service: applied.service || null,
      city: applied.city || null,
      requirement: applied.requirement || null,
      whatsappName: applied.whatsapp_name ?? world.contact.whatsappName,
    };
    conversation.leadId = world.lead.id;
  }

  world.sequence.message += 1;
  world.messages.push({
    direction: 'incoming',
    text: turn.inbound?.text ?? '',
    at: now,
    delivered: true,
  });
  const reply = applied.response_text || '';
  if (reply) {
    world.sequence.message += 1;
    world.messages.push({
      direction: 'outgoing',
      text: reply,
      at: now,
      // Only messages actually sent enter the rebuilt history.
      delivered: turn.outboundDelivered !== false,
    });
  }
  world.lastInboundAt = now;

  return world;
};
