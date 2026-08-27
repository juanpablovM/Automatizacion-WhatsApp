# Métricas PRD 32 — Definiciones formales de KPI (Unidad 7)

> Fuente normativa: `docs/prd-agente-whatsapp-hormiglass.md` secciones 31/32/33.
> Implementación: `infra/postgres/migrations/014_create_metrics_views.sql`.
> Artefacto operativo: `scripts/ops/metrics-report.sh` (reporte Markdown/CSV).

## Convenciones globales

| Concepto | Valor |
|---|---|
| Zona horaria | `America/Santiago` (los timestamps se almacenan `TIMESTAMPTZ`/UTC; las series agregan en horario local de atención) |
| Ventana por defecto | 30 días (`CURRENT_TIMESTAMP - INTERVAL '30 days'`) |
| Ventana configurable | La vista `v_metrics_prd32_kpi` usa 30 días; el reporte puede re-ejecutar las 4 vistas con el parámetro `:window_days` |
| Evento válido | Fila con `deleted_at IS NULL` (soft-delete) y timestamps dentro de la ventana |
| Freshness | Cada fila expone `metric_as_of` (último evento fuente, sin ventana). El reporte marca `stale` si `now() - metric_as_of` supera el umbral (`--stale-hours`, por defecto 24h) |
| No mutación | Vistas SELECT-only; no insertan, no actualizan, no agregan índices destructivos (índices nuevos son `IF NOT EXISTS` aditivos) |

---

## Atención (PRD 32.1) — `v_metrics_prd32_atencion`

| KPI | Nombre | Numerador | Denominador | Fuente | Unidad |
|-----|--------|-----------|-------------|--------|--------|
| KPI-01 | Tiempo de primera respuesta del bot (mediana) | Por conversación: `MIN(created_at)` de primer mensaje `outgoing` − `MIN(created_at)` del primer `incoming`, en minutos | — (se agrega la mediana) | `messages` (direction incoming/outgoing) | minutos |
| KPI-02 | Conversaciones atendidas | `COUNT(*)` conversaciones con `started_at` en ventana | — | `conversations.started_at` | conversaciones |
| KPI-03 | Conversaciones derivadas | `COUNT(DISTINCT conversation.id)` si `status=handed_to_sales` o `handed_to_sales_at IS NOT NULL` | — | `conversations` + `conversation_statuses` | conversaciones |
| KPI-04 | Conversaciones cerradas | `COUNT(*)` con `closed_at IS NOT NULL` en ventana | — | `conversations.closed_at` | conversaciones |
| KPI-05 | Conversaciones sin respuesta del cliente | Último mensaje de la conversación es `outgoing` y estado `waiting_user` | — | `messages.direction` + `conversation_statuses` | conversaciones |
| KPI-06 | Tasa de fallback IA | Nº de evaluaciones con `audit_logs.metadata ? 'fallback_reason'` | Nº de evaluaciones `conversation_state_evaluated` | `audit_logs` | tasa (0..1) |

## Comercial (PRD 32.2) — `v_metrics_prd32_comercial`

| KPI | Nombre | Numerador | Denominador | Fuente | Unidad |
|-----|--------|-----------|-------------|--------|--------|
| KPI-07 | Leads calificados | `leads.is_qualified = TRUE` en ventana | — | `leads` | leads |
| KPI-08 | Leads A/B/C/D detectados | `qualification_context->>'lead_class'` ∈ {A,B,C,D} | — | `conversations.qualification_context` | conversaciones |
| KPI-09 | Cotizaciones solicitadas | `intent = 'quote_request'` | — | `conversations.qualification_context` | conversaciones |
| KPI-10 | Solicitudes de instalación | `intent = 'installation_inquiry'` | — | `conversations.qualification_context` | conversaciones |
| KPI-11 | Solicitudes B2B | `intent = 'b2b_request'` o `customer_type` ∈ {b2b, contractor} | — | `conversations.qualification_context` | conversaciones |
| KPI-12 | Solicitudes de despacho | `intent = 'delivery_inquiry'` | — | `conversations.qualification_context` | conversaciones |
| KPI-13 | Objeciones de precio | `objection_detected = 'price'` | — | `conversations.qualification_context` | conversaciones |
| KPI-14 | Conversión oportunidad → lead promovido | `opportunities.status_code = 'promoted'` en ventana | `opportunities` creadas en ventana | `opportunities` | % |

## Operación (PRD 32.3) — `v_metrics_prd32_operacion`

| KPI | Nombre | Numerador | Denominador | Fuente | Unidad |
|-----|--------|-----------|-------------|--------|--------|
| KPI-15 | Comprobantes recibidos | `intent = 'payment_proof'` | — | `conversations.qualification_context` | conversaciones |
| KPI-16 | Solicitudes de factura | `intent = 'invoice_request'` | — | `conversations.qualification_context` | conversaciones |
| KPI-17 | Reclamos | `intent = 'complaint'` | — | `conversations.qualification_context` | conversaciones |
| KPI-18 | Solicitudes de garantía | `intent = 'warranty_inquiry'` | — | `conversations.qualification_context` | conversaciones |
| KPI-19 | Conversaciones con fotos | conversaciones con ≥1 `media_attachments` | — | `media_attachments` | conversaciones |
| KPI-20 | Conversaciones con datos incompletos | conversaciones (ventana) sin `service` ni `city` ni `requirement` (no vacíos) | — | `conversations.qualification_context` | conversaciones |
| KPI-21 | Handoffs creados | `handoffs` en ventana | — | `handoffs` | handoffs |
| KPI-22 | Handoffs pendientes vencidos | `estado='pending'` y `created_at < now()-24h` | — | `handoffs` | handoffs |
| KPI-23 | Media descargada con hash | `download_state='downloaded'` y `sha256 IS NOT NULL` en ventana | — | `media_attachments` | adjuntos |
| KPI-24 | Media rechazada | `download_state='rejected'` en ventana | — | `media_attachments` | adjuntos |
| KPI-25 | Follow-ups enviados | `follow_ups.estado='sent'` en ventana | — | `follow_ups` | follow_ups |
| KPI-26 | Follow-ups cancelados | `follow_ups.estado='cancelled'` en ventana | — | `follow_ups` | follow_ups |

## Calidad (PRD 32.4) — `v_metrics_prd32_calidad`

| KPI | Nombre | Numerador | Denominador | Fuente | Unidad |
|-----|--------|-----------|-------------|--------|--------|
| KPI-27 | Diagnóstico D.A.T.O.S. completo | conversaciones con `qualification_context.diagnostic_datos` con 5 claves no vacías (`pain scope timing obstacle next_step`) en ventana | conversaciones en ventana | `conversations.qualification_context` | % |
| KPI-28 | Derivas correctas | handoffs con `acknowledged_at` o `resolved_at` en ventana | handoffs en ventana | `handoffs` | % |
| KPI-29 | Leads sin comuna, producto o modalidad | leads en ventana sin `city` ni `service` ni `requirement` | leads en ventana | `leads` | % |
| KPI-30 | Reclamos escalados correctamente | handoffs `area='claims'` con `acknowledged_at` o `resolved_at` | handoffs `area='claims'` en ventana | `handoffs` | % |
| KPI-31 | Opt-outs registrados | `follow_ups.estado='opted_out'` en ventana | — | `follow_ups` | conversaciones |

---

## Serie temporal

- `v_metrics_prd32_serie_diaria`: conteo de conversaciones iniciadas por día calendario (America/Santiago), últimos 30 días. Útil para gráfico de tendencia y verificación de agrupaciones temporales.

## Uso

```bash
# Reporte Markdown (stdout)
scripts/ops/metrics-report.sh
# Reporte con umbral de stale distinto (horas)
scripts/ops/metrics-report.sh --stale-hours 72
# Formato CSV y salida a archivo
scripts/ops/metrics-report.sh --format csv --out /tmp/metrics.csv
```

Harness determinista: `scripts/ops/test-metrics-report-local.sh` (BD temporal docker + fixtures conocidos).

## Dependencias de Unidad 4 (ClickUp)

- El adjunto real de media a ClickUp sigue pendiente (`attach_pending` en `media_attachments`); el KPI-23 mide la descarga con hash, no la subida.
- `monitor_snapshots` (009) queda disponible para que el reporte SI se desee persistir valores; la estrategia elegida en Unidad 7 es consulta en vivo (vistas) y no snapshot accumulation, para no duplicar datos.>