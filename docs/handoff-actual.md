# Handoff Actual

## Estado

`Hormi Atencion` opera como asesor comercial de WhatsApp sobre Evolution API, n8n, PostgreSQL, Gemini y ClickUp.

Estado del repositorio en el corte del `2026-08-08`:

- U1, U3, U5 y U6 tienen remediaciones verificadas en el working tree, todavía sin commit, push ni deploy
- U4, U7, U8 y U9 permanecen pendientes por decisión
- el runtime todavía requiere migraciones, importación, activación y configuración para incorporar esas remediaciones

Último runtime observado, correspondiente a la revisión del `2026-06-30`:

- stack local arriba y healthy
- `WA - Inbound Entry` activo en `n8n`
- `wahormiglass` en `Evolution API` con estado `open`
- contrato local AI y regresión conversacional local en `OK`
- restore check del ultimo backup estructurado en `OK`
- existen ejecuciones reales recientes con lead, ClickUp, notificacion y mensaje saliente exitosos
- el round robin aun incluye un vendedor de pruebas como notificable

El corte canónico vive en [`docs/estado-actual-2026-08-08.md`](./estado-actual-2026-08-08.md).

La instancia local validada incluye:

- entrada y salida real de WhatsApp
- memoria estructurada por conversacion
- asesor comercial Gemini con fuentes oficiales
- diagnostico D.A.T.O.S. y clasificacion A/B/C/D
- creacion y asignacion round robin
- tarea y notificacion en ClickUp
- fallback deterministico y auditoria
- confirmacion al cliente posterior a la creacion real del lead

## Configuracion AI

- proveedor: Google
- endpoint: OpenAI-compatible
- modelo canonico: `gemini-3.1-flash-lite`
- alternativa canary: `gemini-3.5-flash`
- no usar modelos `preview` ni aliases `latest` como default

Los secretos existen solo en `.env`. La configuracion versionada vive en `.env.example` y `docker-compose.yml`.

## Memoria conversacional

La migracion `006_add_conversation_qualification_context.sql` agrega:

- `conversations.qualification_context`
- `conversations.pending_question_key`
- `leads.qualification_context`

El contexto conserva producto, modalidad, comuna, medidas, uso, terreno, acceso, escombros, urgencia, fotos, cliente, D.A.T.O.S., objeciones y clasificacion.

`pending_question_key` permite interpretar `si/no` segun la pregunta vigente. Solo una solicitud explicita inicia de nuevo.

## Fuentes comerciales

En el entorno validado existen:

- 28 productos o servicios activos
- 28 reglas de precio
- 8 condiciones comerciales
- 12 FAQ
- 5 playbooks de objeciones
- 0 cupos de agenda

La AI solo recomienda o informa usando estas fuentes. Agenda, stock, descuentos, pagos y plazos no confirmados se derivan sin prometer.

## Workflows

- `WA - Inbound Entry`: webhook, encadenamiento y handoff verificado
- `WA - Conversation Orchestrator`: memoria, AI, guardrails y persistencia
- `WA - Outbound Messages`: envio y auditoria Evolution API
- `AI - Lead Qualification Assistant`: asesor Gemini y contrato JSON
- `CRM - Lead Creation And Assignment`: lead y round robin
- `CRM - ClickUp Sync Lead`: tarea enriquecida y conversacion
- `CRM - Seller Notification Dispatch`: aviso al responsable
- `OPS - Error Handler`: auditoria y manejo de fallos

Los enlaces se resuelven desde `n8n/workflow-links.json`.

## Validacion ejecutada

- preflight de workflows: OK
- contrato local AI y fallback: OK
- gate U1: 126 PASS / 0 FAIL
- regresión conversacional: 30 casos PASS
- contrato AI: 7 casos PASS
- U2: 20 PASS / 0 FAIL
- U3, U5 y U6: PASS
- `OPS - Error Handler`: smoke OK con auditoria creada
- E2E asesor Vitacura: OK
- respuestas `no` aplicadas a acceso/escombros sin perder contexto
- lead creado y asignado
- ClickUp creado
- `pending_question_key` limpio al finalizar

Comandos:

```bash
sh scripts/dev/sync-n8n-workflows.sh --preflight
sh scripts/ops/test-ai-assistant-local.sh
sh scripts/ops/test-conversation-regression-local.sh
sh scripts/ops/test-advisor-vitacura-e2e.sh
```

## Pendientes reales

- preparar ambientes separados de staging y produccion
- automatizar backups y definir retencion; el backup post-sync autorizado actual es `backups/20260630-145829/`
- agregar monitoreo y alertas productivas
- integrar agenda real si se desea ofrecer horarios
- integrar una fuente verificable de stock o disponibilidad
- ampliar la matriz E2E para pagos, garantias, reclamos y B2B
- implementar carga del binario de adjuntos a ClickUp
- corregir KPI-19, KPI-26 y KPI-29 antes de regenerar la certificación U8
- aplicar las migraciones `015`–`017` e importar, activar y configurar los workflows remediados en el runtime
- sacar vendedores y datos de prueba del flujo operativo real antes de produccion

## Puesta en marcha local

```bash
docker compose --env-file .env up -d
sh scripts/dev/sync-n8n-workflows.sh
```

Si el ambiente es nuevo, las bases secundarias se crean con `infra/postgres/init/001_create_default_databases.sql` en el primer arranque del volumen.
Las migraciones de negocio y cambios de esquema posteriores se aplican manualmente segun el procedimiento operativo.

Para un ambiente existente, aplicar tambien:

```bash
docker compose --env-file .env exec -T postgres \
  psql -U postgres -d crm_whatsapp_app \
  < infra/postgres/migrations/006_add_conversation_qualification_context.sql
```

## Documentos canónicos

- `README.md`
- `docs/arquitectura.md`
- `docs/FLUJO-CONVERSACIONAL-COMPLETO.md`
- `docs/flujo-leads.md`
- `docs/asesor-comercial-ai.md`
- `docs/fuentes-comerciales-ai.md`
- `docs/base-de-datos.md`
- `docs/n8n-workflows.md`
- `docs/guia-produccion.md`
- `docs/runbook-operacion.md`
- `docs/matriz-pruebas-conversacionales.md`

Los documentos de `docs/archive/` son historicos y no describen el runtime vigente.
