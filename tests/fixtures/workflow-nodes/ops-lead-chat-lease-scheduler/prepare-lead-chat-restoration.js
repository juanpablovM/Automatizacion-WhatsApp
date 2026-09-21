// =============================================================================
// OPS - Lead Chat Lease Scheduler — Prepare Lead Chat Restoration
// -----------------------------------------------------------------------------
// Turns one claimed row of 06_claim_expired_ownerships.sql into the shape the
// dispatch node consumes, and decides — before any network call exists — which
// rows have a restoration to attempt at all.
//
// The lease is already released when this node runs. PostgreSQL freed the AI
// inside the claim transaction, so nothing here can re-suppress the bot and
// nothing here is allowed to try: this lane only projects the ClickUp side.
//
// Two claimed rows must never reach ClickUp:
//   - 'skipped_no_previous_status': the claim already wrote the terminal state
//     and a readable restoration_error. There is no previous status to restore
//     and inventing one is worse than leaving the gap visible to an operator.
//   - a row missing its task id or claim token: without either one the
//     completion could not be authorized anyway.
// Both are marked should_complete = false, which makes the completion node send
// a NULL ownership_id and 07_complete_restoration.sql answer 'unknown_ownership'
// without writing a single row. Closing them with a real result would overwrite
// evidence the claim deliberately left behind.
//
// Output (always exactly one item, superset of the claim row):
//   { should_dispatch_restoration, should_complete, restoration_config_error,
//     clickup_task_url, previous_clickup_status, restoration_result,
//     restoration_error, observed_clickup_status, completion_ownership_id }
// =============================================================================

const trimmed = (value) => String(value ?? '').trim();

const prepareLeadChatRestoration = (row) => {
  const ownershipId = Number(row.ownership_id);
  const clickupTaskId = trimmed(row.clickup_task_id);
  const claimToken = trimmed(row.restoration_claim_token);
  const previousStatus = trimmed(row.previous_clickup_status);
  const restorationState = trimmed(row.restoration_state);

  const blockers = [];
  if (!Number.isSafeInteger(ownershipId) || ownershipId <= 0) blockers.push('ownership_id_invalid');
  if (!clickupTaskId) blockers.push('clickup_task_id_missing');
  if (!claimToken) blockers.push('restoration_claim_token_missing');

  // Terminal at claim time. It is not a blocker to report, it is a row that
  // was never queued for ClickUp in the first place: 06 seeds no
  // external_operations row for it.
  const terminalAtClaim = restorationState === 'skipped_no_previous_status';
  if (!terminalAtClaim && !previousStatus) blockers.push('previous_clickup_status_missing');

  const dispatchable = !terminalAtClaim && blockers.length === 0;

  return {
    ...row,
    previous_clickup_status: previousStatus || null,
    should_dispatch_restoration: dispatchable,
    // Only a row that actually reached ClickUp has a claim worth closing.
    should_complete: dispatchable,
    restoration_config_error: terminalAtClaim
      ? 'skipped_no_previous_status'
      : (blockers.length ? blockers.join(',') : null),
    clickup_task_url: dispatchable
      ? `https://api.clickup.com/api/v2/task/${encodeURIComponent(clickupTaskId)}`
      : null,
    // Completion defaults. The dispatch node overwrites them for every row it
    // actually sends; a row it skips arrives at the completion node with a NULL
    // ownership id, which 07 answers without touching any table.
    completion_ownership_id: dispatchable ? ownershipId : null,
    restoration_result: null,
    restoration_error: null,
    observed_clickup_status: null,
  };
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { trimmed, prepareLeadChatRestoration };
}

if (typeof $json !== 'undefined') {
  return { json: prepareLeadChatRestoration($json ?? {}) };
}
