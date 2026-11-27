// =============================================================================
// contact.state runtime (bot -> CRM, protocol revision 1.3 only).
// -----------------------------------------------------------------------------
// Pure helpers for Build Contact State Events. Select Contact State Candidates
// computes each contact's state (seller_held, handed_off, ready_to_quote,
// qualifying, idle) and its latest conversation in SQL; this file adds the two
// values only the bot's JavaScript knows:
// - progress: answered required questions / required questions of the current
//   request, 0-100, read from the stored qualification_context through the
//   same v3 policy builder the conversation uses (the required goals of
//   create_lead and each goal's resolved status), so it never drifts from what
//   the bot itself asks. Nothing here changes the conversation: the builder is
//   a pure function and only its output is read.
// - stage: the bot's pending question, normalized like the policy builder
//   (`confirm` is `final_confirmation`), or null.
// The production Code node gets crm-events-runtime.js, shared/v3-line-items.js
// and shared/v3-policy-builder.js concatenated ahead of this file
// (tests/scripts/sync-workflow-nodes.mjs), so readCrmEventsConfig,
// isValidCrmId and buildV3PolicyInput are outer free variables there; Node test
// harnesses that `require` this file load the siblings instead.
// =============================================================================

const {
  buildContactStateEvent,
  contactStateProgress,
  contactStateStage,
  contactStatePolicyVersion,
} = (() => {
  const loadSibling = (relative) => {
    if (typeof module === 'undefined' || typeof require !== 'function') return null;
    try {
      return require(relative);
    } catch (_error) {
      return null;
    }
  };
  const policyRuntime = loadSibling('../shared/v3-policy-builder.js');
  const crmRuntime = loadSibling('./crm-events-runtime.js');
  const policyBuilder = policyRuntime
    ? policyRuntime.buildV3PolicyInput
    : (typeof buildV3PolicyInput === 'function' ? buildV3PolicyInput : null);
  const validCrmId = crmRuntime
    ? crmRuntime.isValidCrmId
    : (typeof isValidCrmId === 'function' ? isValidCrmId : () => false);

  const STATES = ['ready_to_quote', 'handed_off', 'seller_held', 'qualifying', 'idle'];
  const ID_PREFIX_PATTERN = /^[a-z0-9]{1,16}$/;
  const STAGE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
  const CHANGED_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
  const MAX_VERSION = 2147483647;

  const asContext = (value) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    if (typeof value !== 'string' || value.trim() === '') return {};
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (_error) {
      return {};
    }
  };
  const asCatalog = (value) => {
    if (Array.isArray(value)) return value;
    if (typeof value !== 'string') return [];
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch (_error) {
      return [];
    }
  };
  const positiveInteger = (value) => {
    const number = Number(value);
    return Number.isSafeInteger(number) && number > 0 ? number : null;
  };

  // Mirrors persistedPendingGoal (shared/v3-policy-builder.js); an id outside
  // the contract's snake_case shape (up to 64 characters) is sent as null.
  const contactStateStage = (pendingQuestionKey) => {
    const key = String(pendingQuestionKey ?? '').trim();
    if (!key) return null;
    const stage = key === 'confirm' ? 'final_confirmation' : key;
    return STAGE_PATTERN.test(stage) ? stage : null;
  };

  // The policy version the conversation compiles for this phone, exactly as
  // Compile V3 Turn Policy chooses it (AI_PRD_V3_LINE_ITEMS and its canary).
  const contactStatePolicyVersion = (env = {}, phoneNumber = '') => {
    const digits = (value) => String(value ?? '').replace(/\D/g, '');
    const raw = String(env.AI_PRD_V3_LINE_ITEMS ?? 'disabled').toLowerCase();
    const mode = ['disabled', 'canary', 'enabled'].includes(raw) ? raw : 'disabled';
    if (mode === 'enabled') return 'v3.1';
    if (mode !== 'canary') return 'v3';
    const canary = new Set(String(env.AI_PRD_V3_LINE_ITEMS_CANARY_PHONES || '').split(',').map(digits).filter(Boolean));
    return canary.has(digits(phoneNumber)) ? 'v3.1' : 'v3';
  };

  // ready_to_quote is 100. idle is 0 unless its latest conversation is a
  // request that was not closed (for example one that timed out). Otherwise
  // the share of create_lead's required goals the stored context resolves,
  // rounded down so 100 means every required question is answered.
  const contactStateProgress = (row, version = 'v3.1') => {
    if (row.state === 'ready_to_quote') return 100;
    if (row.state === 'idle' && (row.conversation_id === null || row.conversation_id === undefined
      || row.latest_status_code === 'closed' || !row.latest_status_code)) return 0;
    if (!policyBuilder) throw new Error('contact.state progress needs buildV3PolicyInput');
    const policy = policyBuilder({
      qualification_context: asContext(row.qualification_context),
      pending_question_key: row.pending_question_key ?? null,
      v3_grounding: { catalog: asCatalog(row.catalog) },
    }, { version });
    const requirement = (policy.effect_requirements || []).find((entry) => entry.effect_type === 'create_lead');
    const required = requirement ? requirement.required_goal_ids : [];
    if (required.length === 0) return 0;
    const resolved = new Set((policy.goals || []).filter((goal) => goal.status === 'resolved').map((goal) => goal.goal_id));
    const answered = required.filter((goalId) => resolved.has(goalId)).length;
    return Math.floor((100 * answered) / required.length);
  };

  const blocked = (reason, contactNumber, config, row) => ({
    blocked_reason: reason,
    contact_id: contactNumber,
    id_prefix: config.id_prefix ?? null,
    input_hash: row.input_hash ?? null,
    state_version: null,
    event_id: null,
    body: null,
  });

  // One contact.state body per change of (state, progress, stage,
  // conversation_id) under the id prefix. state_version is proposed by Select
  // Contact State Candidates (the newest one under this prefix + 1) and
  // re-checked under a row lock by Insert Contact State Events. changed_at is
  // the database time of the pass that observed the change.
  const buildContactStateEvent = (row, config = {}, version = 'v3.1') => {
    const contactNumber = positiveInteger(row.contact_id);
    if (contactNumber === null) return blocked('invalid_contact_id', null, config, row);
    if (config.protocol_revision !== '1.3') return blocked('protocol_revision_unsupported', contactNumber, config, row);
    if (typeof config.id_prefix !== 'string' || !ID_PREFIX_PATTERN.test(config.id_prefix)) {
      return blocked('id_prefix_missing', contactNumber, config, row);
    }
    if (!STATES.includes(row.state)) return blocked('invalid_state', contactNumber, config, row);
    const stateVersion = positiveInteger(row.state_version);
    if (stateVersion === null || stateVersion > MAX_VERSION) return blocked('invalid_state_version', contactNumber, config, row);
    const changedAt = String(row.observed_at ?? '');
    if (!CHANGED_AT_PATTERN.test(changedAt)) return blocked('invalid_changed_at', contactNumber, config, row);

    let progress;
    try {
      progress = contactStateProgress(row, version);
    } catch (_error) {
      return blocked('progress_unavailable', contactNumber, config, row);
    }
    const idle = row.state === 'idle';
    const conversationNumber = idle ? null : positiveInteger(row.conversation_id);
    const contactId = `wa-${config.id_prefix}-contact-${contactNumber}`;
    const eventId = `${contactId}-state-${stateVersion}`;
    const conversationId = conversationNumber === null ? null : `wa-${config.id_prefix}-conversation-${conversationNumber}`;
    if (![contactId, eventId, ...(conversationId ? [conversationId] : [])].every(validCrmId)) {
      return blocked('invalid_id', contactNumber, config, row);
    }
    const body = JSON.stringify({
      schema_version: 1,
      protocol_revision: '1.3',
      event_id: eventId,
      type: 'contact.state',
      contact_id: contactId,
      data: {
        state_version: stateVersion,
        state: row.state,
        progress,
        stage: idle ? null : contactStateStage(row.pending_question_key),
        conversation_id: conversationId,
        changed_at: changedAt,
      },
    });
    return {
      blocked_reason: null,
      contact_id: contactNumber,
      id_prefix: config.id_prefix,
      input_hash: row.input_hash ?? null,
      state_version: stateVersion,
      event_id: eventId,
      body,
    };
  };

  return { buildContactStateEvent, contactStateProgress, contactStateStage, contactStatePolicyVersion };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { buildContactStateEvent, contactStateProgress, contactStateStage, contactStatePolicyVersion };
}
