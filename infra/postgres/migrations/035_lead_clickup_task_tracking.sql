-- Lead ClickUp task tracking: the task's current status and the requirement
-- the task last received.
--
-- A customer who corrects a confirmed quote ("son 80 bloques, no 50") used to
-- land in a brand-new conversation, lead and ClickUp task while the seller kept
-- working the stale one. The bot now continues the same quote while its task is
-- still open, and the ClickUp sync updates that same task. Two facts make that
-- possible:
--   * clickup_status / clickup_status_at: the task's latest status, written by
--     the ClickUp status webhook (newest event wins). A task whose status is in
--     CLICKUP_STATUS_RESOLVED is closed and starts a new quote; NULL means no
--     status event yet and counts as open.
--   * clickup_synced_requirement: the requirement the task currently shows.
--     The lead lane runs more than once per confirmation, so "the lead changed"
--     cannot be a flag passed along one run; the sync compares the lead's
--     requirement with this column instead and updates the task when they
--     differ. Existing tasks are backfilled with their lead's requirement.
-- Additive and nullable: the pre-035 workflows ignore these columns.

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS clickup_status TEXT,
  ADD COLUMN IF NOT EXISTS clickup_status_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS clickup_synced_requirement TEXT;

UPDATE leads
SET clickup_synced_requirement = requirement
WHERE clickup_task_id IS NOT NULL
  AND clickup_synced_requirement IS NULL;
