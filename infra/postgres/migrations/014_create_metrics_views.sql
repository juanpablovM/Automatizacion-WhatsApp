-- =============================================================================
-- 014_create_metrics_views.sql — Métricas PRD 32 (Unidad 7, brecha B09)
-- -----------------------------------------------------------------------------
-- Vistas ADITIVAS (solo SELECT, sin mutación de datos) que materializan las
-- métricas del PRD sección 32 sobre las tablas operativas del proyecto.
--
-- Documentación formal de cada KPI (numerador, denominador, ventana, zona
-- horaria, fuente, evento válido): ver docs/metricas-prd32.md
--
-- Convenciones de esta migración:
--   * Ventana por defecto 30 días (configurable en el reporte ejecutando las
--     vistas con el parámetro :window_days).
--   * Zona horaria: los timestamps se almacenan TIMESTAMPTZ (UTC). Las vistas
--     agregan por día en America/Santiago (horario local de atención).
--   * metric_as_of: momento del último evento fuente (sin ventana) para cada
--     KPI; el reporte scripts/ops/metrics-report.sh lo usa para freshness.
--
-- Vistas creadas (todas reemplazables de forma idempotente):
--   v_metrics_prd32_atencion    PRD 32.1 (KPI-01..06)
--   v_metrics_prd32_comercial   PRD 32.2 (KPI-07..14)
--   v_metrics_prd32_operacion   PRD 32.3 (KPI-15..26)
--   v_metrics_prd32_calidad     PRD 32.4 (KPI-27..31)
--   v_metrics_prd32_kpi         unión por KPI (para reporte y tests)
--   v_metrics_prd32_serie_diaria  agregación temporal por día
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Índices aditivos que sostienen las agregaciones (todos IF NOT EXISTS).
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_metrics_messages_conv_dir_created
  ON messages (conversation_id, direction, created_at)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_metrics_media_download_state_created
  ON media_attachments (download_state, created_at)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_metrics_handoffs_estado_created
  ON handoffs (estado, created_at)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_metrics_followups_estado_created
  ON follow_ups (estado, created_at)
  WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- Vista de atención (PRD 32.1)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_metrics_prd32_atencion AS
WITH ventana AS (
  SELECT CURRENT_TIMESTAMP - INTERVAL '30 days' AS window
)
SELECT
  'KPI-01' AS kpi_id,
  'Tiempo de primera respuesta del bot (mediana, minutos)' AS nombre,
  'atencion' AS dominio,
  'min' AS unidad,
  ROUND(
    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY delta_min)::numeric,
    2
  ) AS valor,
  NULL::numeric AS numerador,
  NULL::numeric AS denominador,
  (SELECT MAX(created_at) FROM messages WHERE deleted_at IS NULL) AS metric_as_of
FROM (
  SELECT
    c.id AS conversation_id,
    EXTRACT(EPOCH FROM (
      MIN(m.created_at) FILTER (WHERE m.direction = 'outgoing')
      - MIN(m.created_at) FILTER (WHERE m.direction = 'incoming')
    )) / 60.0 AS delta_min
  FROM conversations c
  JOIN messages m ON m.conversation_id = c.id AND m.deleted_at IS NULL
  CROSS JOIN ventana v
  WHERE c.deleted_at IS NULL
    AND c.started_at >= v.window
  GROUP BY c.id
  HAVING
    MIN(m.created_at) FILTER (WHERE m.direction = 'incoming') IS NOT NULL
    AND MIN(m.created_at) FILTER (WHERE m.direction = 'outgoing') IS NOT NULL
    AND MIN(m.created_at) FILTER (WHERE m.direction = 'outgoing')
        > MIN(m.created_at) FILTER (WHERE m.direction = 'incoming')
) t
UNION ALL
SELECT
  'KPI-02' AS kpi_id,
  'Conversaciones atendidas (entrantes en ventana)' AS nombre,
  'atencion' AS dominio,
  'conversaciones' AS unidad,
  COUNT(*)::numeric AS valor,
  COUNT(*)::numeric AS numerador,
  NULL::numeric AS denominador,
  (SELECT MAX(started_at) FROM conversations WHERE deleted_at IS NULL) AS metric_as_of
FROM conversations c
CROSS JOIN ventana v
WHERE c.deleted_at IS NULL
  AND c.started_at >= v.window
UNION ALL
SELECT
  'KPI-03' AS kpi_id,
  'Conversaciones derivadas' AS nombre,
  'atencion' AS dominio,
  'conversaciones' AS unidad,
  COUNT(DISTINCT c.id)::numeric AS valor,
  COUNT(DISTINCT c.id)::numeric AS numerador,
  NULL::numeric AS denominador,
  (SELECT MAX(started_at) FROM conversations WHERE deleted_at IS NULL) AS metric_as_of
FROM conversations c
CROSS JOIN ventana v
JOIN conversation_statuses cs ON cs.id = c.conversation_status_id
WHERE c.deleted_at IS NULL
  AND c.started_at >= v.window
  AND (
    cs.code = 'handed_to_sales'
    OR c.handed_to_sales_at IS NOT NULL
  )
UNION ALL
SELECT
  'KPI-04' AS kpi_id,
  'Conversaciones cerradas' AS nombre,
  'atencion' AS dominio,
  'conversaciones' AS unidad,
  COUNT(*)::numeric AS valor,
  COUNT(*)::numeric AS numerador,
  NULL::numeric AS denominador,
  (SELECT MAX(closed_at) FROM conversations WHERE deleted_at IS NULL) AS metric_as_of
FROM conversations c
CROSS JOIN ventana v
WHERE c.deleted_at IS NULL
  AND c.started_at >= v.window
  AND c.closed_at IS NOT NULL
UNION ALL
SELECT
  'KPI-05' AS kpi_id,
  'Conversaciones sin respuesta del cliente (ultimo mensaje outgoing)' AS nombre,
  'atencion' AS dominio,
  'conversaciones' AS unidad,
  COUNT(DISTINCT c.id)::numeric AS valor,
  COUNT(DISTINCT c.id)::numeric AS numerador,
  NULL::numeric AS denominador,
  (SELECT MAX(last_message_at) FROM conversations WHERE deleted_at IS NULL) AS metric_as_of
FROM conversations c
CROSS JOIN ventana v
JOIN conversation_statuses cs ON cs.id = c.conversation_status_id
WHERE c.deleted_at IS NULL
  AND c.started_at >= v.window
  AND cs.code = 'waiting_user'
  AND EXISTS (
    SELECT 1
    FROM messages m_out
    WHERE m_out.conversation_id = c.id
      AND m_out.direction = 'outgoing'
      AND m_out.deleted_at IS NULL
      AND NOT EXISTS (
        SELECT 1
        FROM messages m_in
        WHERE m_in.conversation_id = c.id
          AND m_in.direction = 'incoming'
          AND m_in.deleted_at IS NULL
          AND m_in.created_at > m_out.created_at
      )
  )
UNION ALL
SELECT
  'KPI-06' AS kpi_id,
  'Tasa de fallback de IA (invocaciones fallback / evaluaciones)' AS nombre,
  'atencion' AS dominio,
  'tasa' AS unidad,
  ROUND(
    (
      SELECT COUNT(*)::numeric
      FROM audit_logs al
      WHERE al.created_at >= v.window
        AND al.metadata ? 'fallback_reason'
    ) / NULLIF(
      (
        SELECT COUNT(*)::numeric
        FROM audit_logs al
        WHERE al.created_at >= v.window
          AND al.event_name = 'conversation_state_evaluated'
      ),
      0
    ),
    4
  ) AS valor,
  NULL::numeric AS numerador,
  NULL::numeric AS denominador,
  (SELECT MAX(created_at) FROM audit_logs) AS metric_as_of
FROM ventana v;

-- ---------------------------------------------------------------------------
-- Vista comercial (PRD 32.2)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_metrics_prd32_comercial AS
WITH ventana AS (
  SELECT CURRENT_TIMESTAMP - INTERVAL '30 days' AS window
)
SELECT
  'KPI-07' AS kpi_id,
  'Leads calificados (is_qualified)' AS nombre,
  'comercial' AS dominio,
  'leads' AS unidad,
  COUNT(*)::numeric AS valor,
  COUNT(*)::numeric AS numerador,
  NULL::numeric AS denominador,
  (SELECT MAX(created_at) FROM leads WHERE deleted_at IS NULL) AS metric_as_of
FROM leads l
CROSS JOIN ventana v
WHERE l.deleted_at IS NULL
  AND l.is_qualified = TRUE
  AND l.created_at >= v.window
UNION ALL
SELECT
  'KPI-08' AS kpi_id,
  'Leads A/B/C/D detectados' AS nombre,
  'comercial' AS dominio,
  'conversaciones' AS unidad,
  COUNT(*)::numeric AS valor,
  COUNT(*)::numeric AS numerador,
  NULL::numeric AS denominador,
  (SELECT MAX(started_at) FROM conversations WHERE deleted_at IS NULL) AS metric_as_of
FROM conversations c
CROSS JOIN ventana v
WHERE c.deleted_at IS NULL
  AND c.started_at >= v.window
  AND COALESCE(c.qualification_context->>'lead_class', 'none') IN ('A', 'B', 'C', 'D')
UNION ALL
SELECT
  'KPI-09' AS kpi_id,
  'Cotizaciones solicitadas' AS nombre,
  'comercial' AS dominio,
  'conversaciones' AS unidad,
  COUNT(*)::numeric AS valor,
  COUNT(*)::numeric AS numerador,
  NULL::numeric AS denominador,
  (SELECT MAX(started_at) FROM conversations WHERE deleted_at IS NULL) AS metric_as_of
FROM conversations c
CROSS JOIN ventana v
WHERE c.deleted_at IS NULL
  AND c.started_at >= v.window
  AND COALESCE(c.qualification_context->>'intent', '') = 'quote_request'
UNION ALL
SELECT
  'KPI-10' AS kpi_id,
  'Solicitudes de instalacion' AS nombre,
  'comercial' AS dominio,
  'conversaciones' AS unidad,
  COUNT(*)::numeric AS valor,
  COUNT(*)::numeric AS numerador,
  NULL::numeric AS denominador,
  (SELECT MAX(started_at) FROM conversations WHERE deleted_at IS NULL) AS metric_as_of
FROM conversations c
CROSS JOIN ventana v
WHERE c.deleted_at IS NULL
  AND c.started_at >= v.window
  AND COALESCE(c.qualification_context->>'intent', '') = 'installation_inquiry'
UNION ALL
SELECT
  'KPI-11' AS kpi_id,
  'Solicitudes B2B' AS nombre,
  'comercial' AS dominio,
  'conversaciones' AS unidad,
  COUNT(*)::numeric AS valor,
  COUNT(*)::numeric AS numerador,
  NULL::numeric AS denominador,
  (SELECT MAX(started_at) FROM conversations WHERE deleted_at IS NULL) AS metric_as_of
FROM conversations c
CROSS JOIN ventana v
WHERE c.deleted_at IS NULL
  AND c.started_at >= v.window
  AND (
    COALESCE(c.qualification_context->>'intent', '') = 'b2b_request'
    OR COALESCE(c.qualification_context->>'customer_type', '') IN ('b2b', 'contractor')
  )
UNION ALL
SELECT
  'KPI-12' AS kpi_id,
  'Solicitudes de despacho' AS nombre,
  'comercial' AS dominio,
  'conversaciones' AS unidad,
  COUNT(*)::numeric AS valor,
  COUNT(*)::numeric AS numerador,
  NULL::numeric AS denominador,
  (SELECT MAX(started_at) FROM conversations WHERE deleted_at IS NULL) AS metric_as_of
FROM conversations c
CROSS JOIN ventana v
WHERE c.deleted_at IS NULL
  AND c.started_at >= v.window
  AND COALESCE(c.qualification_context->>'intent', '') = 'delivery_inquiry'
UNION ALL
SELECT
  'KPI-13' AS kpi_id,
  'Objeciones de precio' AS nombre,
  'comercial' AS dominio,
  'conversaciones' AS unidad,
  COUNT(*)::numeric AS valor,
  COUNT(*)::numeric AS numerador,
  NULL::numeric AS denominador,
  (SELECT MAX(started_at) FROM conversations WHERE deleted_at IS NULL) AS metric_as_of
FROM conversations c
CROSS JOIN ventana v
WHERE c.deleted_at IS NULL
  AND c.started_at >= v.window
  AND COALESCE(c.qualification_context->>'objection_detected', 'none') = 'price'
UNION ALL
SELECT
  'KPI-14' AS kpi_id,
  'Tasa de conversion oportunidad -> lead promovido' AS nombre,
  'comercial' AS dominio,
  'pct' AS unidad,
  ROUND(
    (
      SELECT COUNT(*)::numeric
      FROM opportunities o
      WHERE o.deleted_at IS NULL
        AND o.status_code = 'promoted'
        AND o.created_at >= v.window
    ) / NULLIF(
      (
        SELECT COUNT(*)::numeric
        FROM opportunities o
        WHERE o.deleted_at IS NULL
          AND o.created_at >= v.window
      ),
      0
    ) * 100,
    2
  ) AS valor,
  NULL::numeric AS numerador,
  NULL::numeric AS denominador,
  (SELECT MAX(created_at) FROM opportunities WHERE deleted_at IS NULL) AS metric_as_of
FROM ventana v;

-- ---------------------------------------------------------------------------
-- Vista de operación (PRD 32.3)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_metrics_prd32_operacion AS
WITH ventana AS (
  SELECT CURRENT_TIMESTAMP - INTERVAL '30 days' AS window
)
SELECT
  'KPI-15' AS kpi_id,
  'Comprobantes recibidos' AS nombre,
  'operacion' AS dominio,
  'conversaciones' AS unidad,
  COUNT(*)::numeric AS valor,
  COUNT(*)::numeric AS numerador,
  NULL::numeric AS denominador,
  (SELECT MAX(started_at) FROM conversations WHERE deleted_at IS NULL) AS metric_as_of
FROM conversations c
CROSS JOIN ventana v
WHERE c.deleted_at IS NULL
  AND c.started_at >= v.window
  AND COALESCE(c.qualification_context->>'intent', '') = 'payment_proof'
UNION ALL
SELECT
  'KPI-16' AS kpi_id,
  'Solicitudes de factura' AS nombre,
  'operacion' AS dominio,
  'conversaciones' AS unidad,
  COUNT(*)::numeric AS valor,
  COUNT(*)::numeric AS numerador,
  NULL::numeric AS denominador,
  (SELECT MAX(started_at) FROM conversations WHERE deleted_at IS NULL) AS metric_as_of
FROM conversations c
CROSS JOIN ventana v
WHERE c.deleted_at IS NULL
  AND c.started_at >= v.window
  AND COALESCE(c.qualification_context->>'intent', '') = 'invoice_request'
UNION ALL
SELECT
  'KPI-17' AS kpi_id,
  'Reclamos registrados' AS nombre,
  'operacion' AS dominio,
  'conversaciones' AS unidad,
  COUNT(*)::numeric AS valor,
  COUNT(*)::numeric AS numerador,
  NULL::numeric AS denominador,
  (SELECT MAX(started_at) FROM conversations WHERE deleted_at IS NULL) AS metric_as_of
FROM conversations c
CROSS JOIN ventana v
WHERE c.deleted_at IS NULL
  AND c.started_at >= v.window
  AND COALESCE(c.qualification_context->>'intent', '') = 'complaint'
UNION ALL
SELECT
  'KPI-18' AS kpi_id,
  'Solicitudes de garantía' AS nombre,
  'operacion' AS dominio,
  'conversaciones' AS unidad,
  COUNT(*)::numeric AS valor,
  COUNT(*)::numeric AS numerador,
  NULL::numeric AS denominador,
  (SELECT MAX(started_at) FROM conversations WHERE deleted_at IS NULL) AS metric_as_of
FROM conversations c
CROSS JOIN ventana v
WHERE c.deleted_at IS NULL
  AND c.started_at >= v.window
  AND COALESCE(c.qualification_context->>'intent', '') = 'warranty_inquiry'
UNION ALL
SELECT
  'KPI-19' AS kpi_id,
  'Conversaciones con fotos adjuntas' AS nombre,
  'operacion' AS dominio,
  'conversaciones' AS unidad,
  COUNT(DISTINCT c.id)::numeric AS valor,
  COUNT(DISTINCT c.id)::numeric AS numerador,
  NULL::numeric AS denominador,
  (SELECT MAX(created_at) FROM media_attachments WHERE deleted_at IS NULL) AS metric_as_of
FROM conversations c
CROSS JOIN ventana v
WHERE c.deleted_at IS NULL
  AND c.started_at >= v.window
  AND EXISTS (
    SELECT 1 FROM media_attachments m
    WHERE m.conversation_id = c.id AND m.deleted_at IS NULL
  )
UNION ALL
SELECT
  'KPI-20' AS kpi_id,
  'Conversaciones con datos incompletos (sin service/city/requirement)' AS nombre,
  'operacion' AS dominio,
  'conversaciones' AS unidad,
  COUNT(*)::numeric AS valor,
  COUNT(*)::numeric AS numerador,
  NULL::numeric AS denominador,
  (SELECT MAX(started_at) FROM conversations WHERE deleted_at IS NULL) AS metric_as_of
FROM conversations c
CROSS JOIN ventana v
WHERE c.deleted_at IS NULL
  AND c.started_at >= v.window
  AND (
    COALESCE(NULLIF(c.qualification_context->>'service', ''), '') = ''
    OR COALESCE(NULLIF(c.qualification_context->>'city', ''), '') = ''
    OR COALESCE(NULLIF(c.qualification_context->>'requirement', ''), '') = ''
  )
UNION ALL
SELECT
  'KPI-21' AS kpi_id,
  'Handoffs creados' AS nombre,
  'operacion' AS dominio,
  'handoffs' AS unidad,
  COUNT(*)::numeric AS valor,
  COUNT(*)::numeric AS numerador,
  NULL::numeric AS denominador,
  (SELECT MAX(created_at) FROM handoffs WHERE deleted_at IS NULL) AS metric_as_of
FROM handoffs h
CROSS JOIN ventana v
WHERE h.deleted_at IS NULL
  AND h.created_at >= v.window
UNION ALL
SELECT
  'KPI-22' AS kpi_id,
  'Handoffs pendientes vencidos (+24h)' AS nombre,
  'operacion' AS dominio,
  'handoffs' AS unidad,
  COUNT(*)::numeric AS valor,
  COUNT(*)::numeric AS numerador,
  NULL::numeric AS denominador,
  (SELECT MAX(created_at) FROM handoffs WHERE deleted_at IS NULL) AS metric_as_of
FROM handoffs h
WHERE h.deleted_at IS NULL
  AND h.estado = 'pending'
  AND h.created_at < CURRENT_TIMESTAMP - INTERVAL '24 hours'
UNION ALL
SELECT
  'KPI-23' AS kpi_id,
  'Media descargada con hash SHA-256' AS nombre,
  'operacion' AS dominio,
  'adjuntos' AS unidad,
  COUNT(*)::numeric AS valor,
  COUNT(*)::numeric AS numerador,
  NULL::numeric AS denominador,
  (SELECT MAX(updated_at) FROM media_attachments WHERE deleted_at IS NULL) AS metric_as_of
FROM media_attachments m
CROSS JOIN ventana v
WHERE m.deleted_at IS NULL
  AND m.download_state = 'downloaded'
  AND m.sha256 IS NOT NULL
  AND m.created_at >= v.window
UNION ALL
SELECT
  'KPI-24' AS kpi_id,
  'Media rechazada' AS nombre,
  'operacion' AS dominio,
  'adjuntos' AS unidad,
  COUNT(*)::numeric AS valor,
  COUNT(*)::numeric AS numerador,
  NULL::numeric AS denominador,
  (SELECT MAX(updated_at) FROM media_attachments WHERE deleted_at IS NULL) AS metric_as_of
FROM media_attachments m
CROSS JOIN ventana v
WHERE m.deleted_at IS NULL
  AND m.download_state = 'rejected'
  AND m.created_at >= v.window
UNION ALL
SELECT
  'KPI-25' AS kpi_id,
  'Follow-ups enviados' AS nombre,
  'operacion' AS dominio,
  'follow_ups' AS unidad,
  COUNT(*)::numeric AS valor,
  COUNT(*)::numeric AS numerador,
  NULL::numeric AS denominador,
  (SELECT MAX(updated_at) FROM follow_ups WHERE deleted_at IS NULL) AS metric_as_of
FROM follow_ups f
CROSS JOIN ventana v
WHERE f.deleted_at IS NULL
  AND f.estado = 'sent'
  AND f.created_at >= v.window
UNION ALL
SELECT
  'KPI-26' AS kpi_id,
  'Follow-ups cancelados (cliente respondio)' AS nombre,
  'operacion' AS dominio,
  'follow_ups' AS unidad,
  COUNT(*)::numeric AS valor,
  COUNT(*)::numeric AS numerador,
  NULL::numeric AS denominador,
  (SELECT MAX(updated_at) FROM follow_ups WHERE deleted_at IS NULL) AS metric_as_of
FROM follow_ups f
CROSS JOIN ventana v
WHERE f.deleted_at IS NULL
  AND f.estado = 'cancelled'
  AND f.created_at >= v.window;

-- ---------------------------------------------------------------------------
-- Vista de calidad (PRD 32.4)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_metrics_prd32_calidad AS
WITH ventana AS (
  SELECT CURRENT_TIMESTAMP - INTERVAL '30 days' AS window
)
SELECT
  'KPI-27' AS kpi_id,
  'pct conversaciones con diagnostico D.A.T.O.S. completo' AS nombre,
  'calidad' AS dominio,
  'pct' AS unidad,
  ROUND(
    (
      SELECT COUNT(*)::numeric
      FROM conversations ev
      WHERE ev.deleted_at IS NULL
        AND ev.started_at >= v.window
        AND ev.qualification_context ? 'diagnostic_datos'
        AND ev.qualification_context->'diagnostic_datos' ?& ARRAY['pain', 'scope', 'timing', 'obstacle', 'next_step']
        AND COALESCE(ev.qualification_context->'diagnostic_datos'->>'pain', '') <> ''
        AND COALESCE(ev.qualification_context->'diagnostic_datos'->>'scope', '') <> ''
        AND COALESCE(ev.qualification_context->'diagnostic_datos'->>'timing', '') <> ''
        AND COALESCE(ev.qualification_context->'diagnostic_datos'->>'obstacle', '') <> ''
        AND COALESCE(ev.qualification_context->'diagnostic_datos'->>'next_step', '') <> ''
    ) / NULLIF(
      (
        SELECT COUNT(*)::numeric
        FROM conversations ev
        WHERE ev.deleted_at IS NULL
          AND ev.started_at >= v.window
      ),
      0
    ) * 100,
    2
  ) AS valor,
  NULL::numeric AS numerador,
  NULL::numeric AS denominador,
  (SELECT MAX(started_at) FROM conversations WHERE deleted_at IS NULL) AS metric_as_of
FROM ventana v
UNION ALL
SELECT
  'KPI-28' AS kpi_id,
  'pct derivaciones correctas (handoffs acknowledge/resolved)' AS nombre,
  'calidad' AS dominio,
  'pct' AS unidad,
  ROUND(
    (
      SELECT COUNT(*)::numeric
      FROM handoffs h
      WHERE h.deleted_at IS NULL
        AND h.created_at >= v.window
        AND (h.acknowledged_at IS NOT NULL OR h.resolved_at IS NOT NULL)
    ) / NULLIF(
      (
        SELECT COUNT(*)::numeric
        FROM handoffs h
        WHERE h.deleted_at IS NULL
          AND h.created_at >= v.window
      ),
      0
    ) * 100,
    2
  ) AS valor,
  NULL::numeric AS numerador,
  NULL::numeric AS denominador,
  (SELECT MAX(created_at) FROM handoffs WHERE deleted_at IS NULL) AS metric_as_of
FROM ventana v
UNION ALL
SELECT
  'KPI-29' AS kpi_id,
  'pct leads sin comuna, producto o modalidad' AS nombre,
  'calidad' AS dominio,
  'pct' AS unidad,
  ROUND(
    (
      SELECT COUNT(*)::numeric
      FROM leads l
      WHERE l.deleted_at IS NULL
        AND l.created_at >= v.window
        AND (
          COALESCE(NULLIF(l.city, ''), '') = ''
          OR COALESCE(NULLIF(l.service, ''), '') = ''
          OR COALESCE(NULLIF(l.requirement, ''), '') = ''
        )
    ) / NULLIF(
      (
        SELECT COUNT(*)::numeric
        FROM leads l
        WHERE l.deleted_at IS NULL AND l.created_at >= v.window
      ),
      0
    ) * 100,
    2
  ) AS valor,
  NULL::numeric AS numerador,
  NULL::numeric AS denominador,
  (SELECT MAX(created_at) FROM leads WHERE deleted_at IS NULL) AS metric_as_of
FROM ventana v
UNION ALL
SELECT
  'KPI-30' AS kpi_id,
  'pct reclamos escalados correctamente (handoffs area claims ack)' AS nombre,
  'calidad' AS dominio,
  'pct' AS unidad,
  ROUND(
    (
      SELECT COUNT(*)::numeric
      FROM handoffs h
      WHERE h.deleted_at IS NULL
        AND h.created_at >= v.window
        AND h.area = 'claims'
        AND (h.acknowledged_at IS NOT NULL OR h.resolved_at IS NOT NULL)
    ) / NULLIF(
      (
        SELECT COUNT(*)::numeric
        FROM handoffs h
        WHERE h.deleted_at IS NULL
          AND h.created_at >= v.window
          AND h.area = 'claims'
      ),
      0
    ) * 100,
    2
  ) AS valor,
  NULL::numeric AS numerador,
  NULL::numeric AS denominador,
  (SELECT MAX(created_at) FROM handoffs WHERE deleted_at IS NULL) AS metric_as_of
FROM ventana v
UNION ALL
SELECT
  'KPI-31' AS kpi_id,
  'Opt-outs registrados' AS nombre,
  'calidad' AS dominio,
  'conversaciones' AS unidad,
  COUNT(*)::numeric AS valor,
  COUNT(*)::numeric AS numerador,
  NULL::numeric AS denominador,
  (SELECT MAX(updated_at) FROM follow_ups WHERE deleted_at IS NULL) AS metric_as_of
FROM follow_ups f
CROSS JOIN ventana v
WHERE f.deleted_at IS NULL
  AND f.estado = 'opted_out'
  AND f.created_at >= v.window;

-- ---------------------------------------------------------------------------
-- Vista unificada por KPI (para el reporte y los tests).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_metrics_prd32_kpi AS
SELECT kpi_id, nombre, dominio, unidad, valor, numerador, denominador, metric_as_of
FROM v_metrics_prd32_atencion
UNION ALL
SELECT kpi_id, nombre, dominio, unidad, valor, numerador, denominador, metric_as_of
FROM v_metrics_prd32_comercial
UNION ALL
SELECT kpi_id, nombre, dominio, unidad, valor, numerador, denominador, metric_as_of
FROM v_metrics_prd32_operacion
UNION ALL
SELECT kpi_id, nombre, dominio, unidad, valor, numerador, denominador, metric_as_of
FROM v_metrics_prd32_calidad;

-- ---------------------------------------------------------------------------
-- Serie diaria (agrupación temporal en America/Santiago).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_metrics_prd32_serie_diaria AS
SELECT
  (c.started_at AT TIME ZONE 'America/Santiago')::date AS fecha,
  COUNT(DISTINCT c.id)::numeric AS conversaciones_iniciadas
FROM conversations c
WHERE c.deleted_at IS NULL
  AND c.started_at >= CURRENT_TIMESTAMP - INTERVAL '30 days'
GROUP BY 1
ORDER BY 1 DESC;