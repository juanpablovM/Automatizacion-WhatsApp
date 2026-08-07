-- =============================================================================
-- 02_claim_due_follow_ups.sql — Reclama items vencidos para este tick.
-- Nodo n8n: "Claim Due Follow Ups" (OPS - Follow-Up Scheduler).
-- -----------------------------------------------------------------------------
-- Delega en claim_due_follow_ups() (migration 013): lock FOR UPDATE
-- SKIP LOCKED + ventana horaria. Devuelve SOLO lo reclamado por este tick.
-- Los items fuera de ventana quedan pending (se reevaluaran).
--
-- Params:
--   :batch_size       max items por tick (default 50)
--   :window_start     'HH:MM' hora local (default 09:00)
--   :window_end       'HH:MM' hora local (default 20:00)
--   :now              reloj del tick (determinista en tests; NOW() en prod)
--   :claim_stale_seconds  abandonar claims viejos mas alla de N segundos
-- =============================================================================
SELECT * FROM claim_due_follow_ups(
  NULLIF(:batch_size::text, '')::integer,
  NULLIF(:window_start::text, ''),
  NULLIF(:window_end::text, ''),
  COALESCE(NULLIF(:now::text, '')::timestamptz, NOW()),
  NULLIF(:claim_stale_seconds::text, '')::integer
);