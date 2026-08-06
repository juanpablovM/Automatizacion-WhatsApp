-- Reconciliation of failed inbound events (R3)
-- Idempotent UPDATE: only affects rows where processing_status = 'failed'
-- Events: 17, 26, 31, 56, 72, 82
-- Run in two phases: first 17,26,31,56,72 (pre-send), then 82 (post-send)

-- Phase 1: Reconcile events 17, 26, 31, 56, 72 (before sending handoff to conv 95)
UPDATE inbound_events
SET processing_status = 'processed',
    processing_phase = 'completed',
    processed_at = NOW(),
    failed_at = NULL,
    processing_token = NULL,
    failure_reason = NULL,
    updated_at = NOW()
WHERE id IN (17, 26, 31, 56, 72)
  AND processing_status = 'failed';

-- Phase 2: Reconcile event 82 (AFTER sending handoff to conv 95)
-- UPDATE inbound_events
-- SET processing_status = 'processed',
--     processing_phase = 'completed',
--     processed_at = NOW(),
--     failed_at = NULL,
--     processing_token = NULL,
--     failure_reason = NULL,
--     updated_at = NOW()
-- WHERE id = 82
--   AND processing_status = 'failed';

-- Verification: run again to confirm idempotency (should affect 0 rows)
-- UPDATE inbound_events
-- SET processing_status = 'processed',
--     processing_phase = 'completed',
--     processed_at = NOW(),
--     failed_at = NULL,
--     processing_token = NULL,
--     failure_reason = NULL,
--     updated_at = NOW()
-- WHERE id IN (17, 26, 31, 56, 72, 82)
--   AND processing_status = 'failed';