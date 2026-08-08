# Reporte de certificacion PRD — 2026-08-07 20:24

- SHA: `ac80def` (2026-08-07)
- Entorno: local, docker (crm_whatsapp_cert_2927581), sin red externa

## Capa A — Casos normativos CS-001..CS-008 (PRD #31, textos literales)

| CS | Requisito | Resultado |
|---|---|---|
| CS-001 | #31.1 precio cierre | PASS |
| CS-002 | #31.2 mas barato | PASS |
| CS-003 | #31.3 constructora B2B | PASS |
| CS-004 | #31.4 comprobante | PASS |
| CS-005 | #31.5 instalar pastelones | PASS |
| CS-006 | #31.6 factura | PASS |
| CS-007 | #31.7 reclamo instalacion | PASS |
| CS-008 | #31.8 stock | PASS |

Capa A: 26 PASS / 0 FAIL · Capa B: 11 PASS / 0 FAIL

## Capa B — Guardrails PRD #29

| Guardrail | Resultado |
|---|---|
| G-01 NO_INVENT_PRICE | PASS (CS-001) |
| G-02 NO_CONFIRM_STOCK | PASS (CS-008) |
| G-03 NO_CONFIRM_PAYMENT | PASS (CS-004) |
| G-04 NO_PROMISE_DELIVERY | PASS |
| G-05 NO_PROMISE_INSTALLATION | PASS |
| G-06 NO_DISCOUNT | PASS (CS-002) |
| G-07 B2B derivacion | PASS (CS-003) |
| G-08 Emision de documentos | PASS (CS-006) |
| G-09 Garantia/Postventa | PASS |
| G-10 Plazos sin validacion | PASS (NO_PROMISE_DELIVERY) |
| G-11 No discutir | NO_COVERED (prompt AI) |
| G-12 No culpar a otras areas | NO_COVERED (prompt AI) |
| G-13 Sin tecnicismos | NO_COVERED (prompt AI) |
| G-14 No contradiccion del proceso | NO_COVERED (prompt AI) |
| G-15 No cerrar sin humano | PASS (gate handoff) |

Nota honesta: los CS/guardrails no deterministas (G-11..G-14) viven en el
prompt del LLM, no en codigo. Su enforcement no es verificable aqui.

## Capa CR — Criterios de aceptacion CR-001..CR-020 (PRD #33, docs/matriz-cumplimiento-prd.md seccion 5)

| Criterio | Nombre | Resultado | Prueba vinculada |
|---|---|---|---|
| CR-001 | Responde de forma clara y profesional | PASS | Capa A (CS-001..CS-008: fallbacks y textos verificados) |
| CR-002 | No inventa precios ni stock | PASS | CS-001 (NO_INVENT_PRICE) + CS-008 (NO_CONFIRM_STOCK) |
| CR-003 | No verifica pagos | PASS | CS-004 (NO_CONFIRM_PAYMENT) |
| CR-004 | Detecta la intencion del cliente | NO_COVERED | Requiere test-ai-assistant-local.sh / conversation-regression (fuera de esta suite) |
| CR-005 | Levanta datos minimos | PASS | Capa D: test-intent-commercial-gate-local.sh (gate de campos obligatorios por intencion, PRD #13) |
| CR-006 | Usa el diagnostico D.A.T.O.S. | NO_COVERED | Calidad de extraccion en el LLM; requiere test-ai-assistant-local.sh (schema D.A.T.O.S.) |
| CR-007 | Clasifica Leads A/B/C/D | PASS | CS-003 (lead_class D) |
| CR-008 | Detecta B2B | PASS | CS-003 (customer_type b2b) |
| CR-009 | Detecta instalacion | PASS | CS-005 (modality installation) |
| CR-010 | Pregunta por retiro de escombros cuando corresponde | PASS | CS-005 (respuesta incluye escombros) |
| CR-011 | Maneja objeciones sin bajar el precio automaticamente | PASS | CS-002 (NO_DISCOUNT, deriva a ejecutiva) |
| CR-012 | Deriva a humano cuando corresponde | PASS | CS-006/CS-007 + Capa C (handoff durable) + G-09 |
| CR-013 | Registra datos en CRM / ClickUp | PASS | Capa C: Persist Lead And Rotation (lead real en CRM); sync ClickUp requiere harness E2E (fuera de esta suite) |
| CR-014 | Adjunta archivos o fotos a la oportunidad | NO_COVERED | media-pipeline valida persistencia, pero el adjunto real a ClickUp esta PENDIENTE (attach_pending) |
| CR-015 | Crea un resumen util para la ejecutiva | NO_COVERED | Requiere test-ai-assistant-local.sh (schema executive_summary) |
| CR-016 | No cierra reclamos sin derivacion | PASS | CS-007 (gate: sin handoff no cierra, con handoff notificado si) |
| CR-017 | No cuenta plazos no validados | PASS | Capa B: G-04/G-05/G-10 (NO_PROMISE_DELIVERY / NO_PROMISE_INSTALLATION) |
| CR-018 | Deja claro el siguiente paso | NO_COVERED | next_best_action dependiente del LLM; requiere conversation-regression |
| CR-019 | Alimenta metricas | PASS | Capa D: test-metrics-report-local.sh (vistas de metricas) |
| CR-020 | Mejora la calidad de las conversaciones comerciales | NO_COVERED | Sin metrica de calidad definida (PRD #3, sin instrumentacion) |

Capa CR: 14 PASS / 6 NO_COVERED (20 criterios)

## Capa C — Persistencia real (queries de workflow)

| Query real | Valida | Resultado |
|---|---|---|
| Persist Lead And Rotation | CR-013 lead durable | PASS |
| Upsert Escalation Handoff | CR-012 handoff idempotente | PASS |
| Upsert Early Opportunity | CR-010/CR-019 oportunidad temprana | PASS |

## Capa D — Regresion local (Unidades 1-7)

| Harness | Estado |
|---|---|
| intent-commercial-gate | PASS |
| opportunity-cycle | PASS |
| handoff-routing | PASS |
| media-pipeline | PASS |
| followup-cadence | PASS |
| metrics-report | PASS |

## Resultado final: 15 PASS / 0 FAIL

> Generado por test-prd-certification-local.sh — no modificar manualmente.
