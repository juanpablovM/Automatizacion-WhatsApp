# Queries n8n

## Objetivo

Versionar las queries SQL principales que usaran los workflows de `n8n` contra la base `crm_whatsapp_app`.

## Alcance

Estas queries sirven como plantillas operativas para los nodos `Postgres` de `n8n`.

No se ejecutan directamente desde el repo sin adaptar variables, porque usan placeholders logicos.

## Convencion de placeholders

Las queries usan placeholders como:

- `:phone_number`
- `:conversation_id`
- `:lead_id`

Estos valores deben ser reemplazados o mapeados desde `n8n` en la fase de implementacion de los nodos.

## Carpetas

- `wa-conversation-orchestrator/`
- `wa-outbound-messages/`
- `crm-lead-creation-and-assignment/`
- `crm-clickup-sync-lead/`
- `crm-seller-notification-dispatch/`
- `ai-sales-advisor/`
- `ops-error-handler/`
- `opportunity-cycle/`

## Ciclo de oportunidad (PRD A-001)

- `opportunity-cycle/01_upsert_early_opportunity.sql`
  - crea o madura la oportunidad de una conversacion al primer mensaje
  - idempotente por conversacion (indice unico parcial `uq_opportunities_conversation`)
  - promueve a `qualified` solo cuando el gate comercial quedo limpio y el cliente confirmo
  - traza cada resultado en `audit_logs` (`created`, `duplicate_skipped`, `promoted_qualified`, `updated`)
  - las intenciones operativas (reclamo, garantia, comprobante, factura) no escriben
- `opportunity-cycle/02_link_promoted_lead.sql`
  - vincula la oportunidad al lead recien creado y la pasa a `promoted`
  - idempotente: un replay del sub-workflow no re-vincula

## Asesor comercial AI

- `ai-sales-advisor/01_load_commercial_context.sql`
  - devuelve un JSON con catalogo activo, reglas de precio vigentes, condiciones comerciales, FAQ, objeciones y slots de agenda disponibles
  - sirve como punto de entrada para enriquecer `AI - Lead Qualification Assistant` o su evolucion a `AI - Sales Advisor`
  - no debe usarse para prometer precios, descuentos o agenda sin las validaciones del workflow padre

## Queries operativas fuera de n8n

Las consultas bajo `db/queries/ops/` son read-only y sirven para readiness,
soporte y reportes manuales. No son nodos de workflow.

- `ops/clickup-readiness/01_seller_notifiability_audit.sql`
  - revisa vendedores activos, `clickup_user_id`, posibles datos de prueba y duplicados de usuario ClickUp
- `ops/clickup-readiness/02_round_robin_readiness.sql`
  - valida puntero de round robin, vendedores notificables y fallos recientes `no_notifiable_seller`
- `ops/clickup-readiness/03_validation_data_candidates.sql`
  - lista leads/tareas candidatos a datos de validacion usando IDs documentados y heuristicas conservadoras
- `ops/clickup-readiness/04_metrics_excluding_validation.sql`
  - plantilla de metricas que excluye datos de validacion conocidos

## Base objetivo

Las queries del CRM deben apuntar a:

- base: `crm_whatsapp_app`
- schema: `public`

## Nota

Las queries privilegian claridad y versionado sobre microoptimizacion prematura.
