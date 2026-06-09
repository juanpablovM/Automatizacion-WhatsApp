# Handoff Actual

## Objetivo de este documento

Permitir retomar el proyecto en un chat nuevo sin depender del historial conversacional anterior.

## Ruta del proyecto

- `/Users/juanpablovonmarttens/Documents/Automatización /crm-whatsapp-automatizado`

## Estado actual del proyecto

El proyecto ya tiene implementadas las bases de:

- estructura versionable del repo
- infraestructura local con `Docker Compose`
- `n8n` self-hosted funcionando localmente
- `PostgreSQL` funcionando localmente
- base de datos del CRM inicial ya creada
- separacion entre base interna de `n8n` y base del CRM
- ClickUp conectado y validado con prueba real
- migracion tecnica de WhatsApp a `Evolution API` ya aplicada en infraestructura y workflows
- sub-workflow `AI - Lead Qualification Assistant` alineado con OpenClaw y el agente oficial `hormi-atencion`
- bridge HTTP local `scripts/ai/hormi-atencion-bridge.js` preparado para Hormi Atencion

Estado real validado en la instancia local actual:

- la sesion de WhatsApp fue reabierta y enlazada nuevamente
- la instancia activa real es `wahormiglass`
- el webhook actual apunta al workflow activo `WA - Inbound Entry`
- se confirmo una conversacion real procesada de punta a punta
- se confirmo salida real por WhatsApp con estado `sent`
- se confirmo derivacion comercial y `clickup_task_sync` en auditoria
- se corrigio `scripts/dev/evolution-connect-instance.sh` para tomar la instancia real desde `.env`
- se actualizo el smoke `scripts/ops/test-error-handler.sh` para usar una bandera de prueba explicita en vez de un timestamp basura

## Resumen ejecutivo rapido

Hoy el proyecto ya tiene:

- infraestructura local funcional
- `n8n` accesible en navegador
- `PostgreSQL` operativo
- base CRM separada de la base interna de `n8n`
- modelo de datos inicial creado y sembrado
- workflows base importados en `n8n`
- credencial PostgreSQL ya creada en `n8n`
- `WA - Conversation Orchestrator` con logica conversacional real y salida util para encadenamiento
- `WA - Inbound Entry` adaptado a `Evolution API`
- `WA - Outbound Messages` adaptado a `Evolution API`
- `CRM - Lead Creation And Assignment` con logica SQL real
- `CRM - ClickUp Sync Lead` con payload real, comentario conversacional completo y retorno estable hacia el workflow padre
- `CRM - Seller Notification Dispatch` con despacho real de notificacion interna
- `OPS - Error Handler` con logica real de auditoria y marcado de lead en error
- `AI - Lead Qualification Assistant` como capa oficial de Hormi Atencion; decide la conversacion y puede habilitar leads confirmados, mientras n8n ejecuta persistencia e integraciones
- ClickUp ya validado con tarea real:
  - `86agtc6z3`
  - `https://app.clickup.com/t/86agtc6z3`

Lo que aun falta cerrar por el integrador:

- integrar las ramas de la fase multiagente en el orden definido
- ejecutar baseline con AI apagada
- levantar bridge OpenClaw con `OPENCLAW_AGENT=hormi-atencion`
- validar Hormi Atencion y matriz conversacional con servicios vivos
- cerrar completamente el smoke de `OPS - Error Handler`
- completar la checklist de salida a produccion

Nota de orden documental:

- la carpeta `.hermes` fue eliminada del workspace
- no debe reintroducirse como fuente paralela de planificacion
- el estado real y los pendientes vigentes viven en `README.md`, este handoff y `docs/guia-produccion.md`

## Infraestructura local

### Servicios Docker

- `n8n`
  - URL: `http://localhost:5678`
- `postgres`
  - host local: `127.0.0.1`
  - puerto local: `5433`
- `evolution-api`
  - URL esperada: `http://localhost:8080`
- `redis`
  - uso interno del stack
  - cache habilitado por defecto para `Evolution API`

### Bases de datos

- `crm_whatsapp`
  - base interna de `n8n`
- `crm_whatsapp_app`
  - base del CRM
- `evolution_api`
  - base tecnica de `Evolution API`

## Variables importantes

Archivo local:

- `.env`

Plantilla:

- `.env.example`

Variables clave ya contempladas:

- `POSTGRES_DB=crm_whatsapp`
- `APP_POSTGRES_DB=crm_whatsapp_app`
- `EVOLUTION_POSTGRES_DB=evolution_api`
- `EVOLUTION_SERVER_URL=http://localhost:8080`
- `EVOLUTION_API_BASE_URL=http://evolution-api:8080`
- `EVOLUTION_API_KEY=...`
- `EVOLUTION_DEFAULT_INSTANCE=principal`
- estado real actual en el workspace local:
  - `EVOLUTION_DEFAULT_INSTANCE=wahormiglass`
- `EVOLUTION_WEBHOOK_SECRET=...`
- `EVOLUTION_WEBHOOK_URL=http://n8n:5678/webhook/<WA_INBOUND_WORKFLOW_ID>/evolutionwebhook/wa-inbound-entry?token=<EVOLUTION_WEBHOOK_SECRET>`
- `EVOLUTION_REDIS_ENABLED=true`
- `EVOLUTION_SAVE_INSTANCES_IN_REDIS=true`
- `CLICKUP_API_TOKEN=...`
- `CLICKUP_LIST_ID=901326797183`
- `CLICKUP_TEAM_ID=9013271719`
- `CLICKUP_CF_*` ya cargados en `.env`
- `AI_LEAD_ASSISTANT_ENABLED=true` en `.env.example`
- `AI_PROVIDER=openclaw`
- `AI_API_KEY_REQUIRED=false`
- `OPENCLAW_BRIDGE_URL=http://host.docker.internal:9090`
- `OPENCLAW_AGENT=hormi-atencion`
- `OPENCLAW_BRIDGE_TOKEN` real solo debe existir en el workspace del integrador y nunca en Git
- OpenClaw queda documentado en `docs/openclaw-configuracion.md`

## Documentacion clave

Leer al retomar:

- [`README.md`](/Users/juanpablovonmarttens/Documents/Automatización%20/crm-whatsapp-automatizado/README.md)
- [`docs/arquitectura.md`](/Users/juanpablovonmarttens/Documents/Automatización%20/crm-whatsapp-automatizado/docs/arquitectura.md)
- [`docs/flujo-leads.md`](/Users/juanpablovonmarttens/Documents/Automatización%20/crm-whatsapp-automatizado/docs/flujo-leads.md)
- [`docs/base-de-datos.md`](/Users/juanpablovonmarttens/Documents/Automatización%20/crm-whatsapp-automatizado/docs/base-de-datos.md)
- [`docs/n8n-workflows.md`](/Users/juanpablovonmarttens/Documents/Automatización%20/crm-whatsapp-automatizado/docs/n8n-workflows.md)
- [`docs/clickup-configuracion.md`](/Users/juanpablovonmarttens/Documents/Automatización%20/crm-whatsapp-automatizado/docs/clickup-configuracion.md)
- [`docs/evolution-api.md`](/Users/juanpablovonmarttens/Documents/Automatización%20/crm-whatsapp-automatizado/docs/evolution-api.md)
- [`docs/bitacora-validacion-ai.md`](/Users/juanpablovonmarttens/Documents/Automatización%20/crm-whatsapp-automatizado/docs/bitacora-validacion-ai.md)
- [`docs/guia-produccion.md`](/Users/juanpablovonmarttens/Documents/Automatización%20/crm-whatsapp-automatizado/docs/guia-produccion.md)
- [`docs/openclaw-configuracion.md`](/home/agentesai/Automatizacion-WhatsApp/docs/openclaw-configuracion.md)

## Decisiones funcionales ya cerradas

- canal de entrada funcional: WhatsApp
- proveedor actual elegido: `Evolution API`
- proveedor AI actual elegido: OpenClaw local con agente `hormi-atencion` (`Hormi Atencion`)
- flujo guiado con extraccion de contexto libre
- preguntas base:
  - servicio
  - ciudad
  - requerimiento
- criterio de creacion de lead:
  - `servicio + ciudad + requerimiento concreto + confirmacion`
- si hay solo intencion inicial:
  - se pregunta por el dato faltante antes de crear lead
  - no se deriva como parcial
- duplicados:
  - mismo telefono
  - retoma conversacion dentro de 24 horas
  - despues de 24 horas puede crear nuevo lead enlazado al anterior
- asignacion:
  - round robin secuencial simple
- politica AI:
  - Hormi Atencion decide la conversacion asistida y puede habilitar leads confirmados
  - `n8n` y PostgreSQL ejecutan persistencia, ClickUp y asignacion
  - la AI no escribe directamente en PostgreSQL
  - la AI no crea tareas en ClickUp fuera del workflow
  - la AI no asigna vendedores fuera del round robin
  - si OpenClaw falla, baja confianza o devuelve JSON invalido, el flujo debe caer a logica deterministica/fallback seguro
- politica de secretos:
  - `.env` real no se commitea ni se comparte entre agentes
  - agentes no integradores trabajan con `.env.example`, samples, mocks y tests locales
  - el integrador es el unico rol autorizado para usar `OPENCLAW_BRIDGE_TOKEN`, `CLICKUP_API_TOKEN`, `EVOLUTION_API_KEY` y credenciales reales

## Workflows existentes en n8n

Ya importados:

- `WA - Inbound Entry`
- `WA - Conversation Orchestrator`
- `WA - Outbound Messages`
- `CRM - Lead Creation And Assignment`
- `CRM - ClickUp Sync Lead`
- `CRM - Seller Notification Dispatch`
- `AI - Lead Qualification Assistant`
- `OPS - Error Handler`

JSON versionados en:

- [`n8n/workflows/`](/Users/juanpablovonmarttens/Documents/Automatización%20/crm-whatsapp-automatizado/n8n/workflows)

Sincronizacion recomendada:

```bash
sh scripts/dev/sync-n8n-workflows.sh --preflight
sh scripts/dev/sync-n8n-workflows.sh
```

Los enlaces entre sub-workflows se mantienen por nombre en `n8n/workflow-links.json`; el script resuelve IDs reales y conecta `OPS - Error Handler` como workflow de errores.

Estado real de implementacion:

- `WA - Inbound Entry`
  - adaptado a payload entrante de `Evolution API`
  - responde `accepted`
  - encadena conversacion, salida, lead, ClickUp y notificacion
  - el webhook activo actual es `6TgrfXCUUixpJOWh/evolutionwebhook/wa-inbound-entry`
- `WA - Conversation Orchestrator`
  - lectura de contexto, evaluacion conversacional, confirmacion, persistencia y salida combinada
  - flujo real validado con conversacion completa y derivacion
- `WA - Outbound Messages`
  - encola mensaje saliente
  - usa endpoint `sendText` de `Evolution API`
  - persiste resultado de entrega y auditoria
  - salida real validada nuevamente despues de reabrir la sesion de WhatsApp
- `CRM - Lead Creation And Assignment`
  - creacion de lead solo con datos confirmados y round robin real
- `CRM - ClickUp Sync Lead`
  - payload real de ClickUp
  - tarea real en ClickUp
  - comentario `Conversación Completa Cliente`
  - retorno estable con `lead_id`, `clickup_task_id` y `clickup_task_url`
- `CRM - Seller Notification Dispatch`
  - notificacion interna por comentario asignado en ClickUp
- `OPS - Error Handler`
  - auditoria y marcado de lead en error
  - pendiente de cierre fino en smoke test controlado
- `AI - Lead Qualification Assistant`
  - contrato JSON controlado para extraccion, redaccion y decision confirmada
  - conectado a OpenClaw mediante `POST /api/evaluate`
  - prueba local con mocks: `sh scripts/ops/test-ai-assistant-local.sh`
  - no usa secretos reales fuera del workspace del integrador

## ClickUp

Estado actual:

- lista real conectada: `Leads Entrantes`
- custom fields reales creados y mapeados en `.env`
- smoke test real ejecutado con exito
- tarea de prueba creada:
  - `86agtc6z3`
  - `https://app.clickup.com/t/86agtc6z3`
- prueba end-to-end validada con lead 22:
  - tarea `86ah3ntj1`
  - notificacion `seller_notification_dispatch` exitosa
- prueba end-to-end con comentario completo validada con lead 24:
  - tarea `86ah3pba6`
  - comentario completo creado con id `90130257660080`
  - notificacion `seller_notification_dispatch` exitosa
- lead real 20 recuperado con notificacion interna exitosa:
  - tarea `86ah3nq8a`
  - audit id `194`

Workflow auxiliar temporal:

- [`n8n/workflows/test-clickup-sync-smoke.json`](/Users/juanpablovonmarttens/Documents/Automatización%20/crm-whatsapp-automatizado/n8n/workflows/test-clickup-sync-smoke.json)

## Evolution API

Estado actual:

- `docker-compose.yml` ya incluye `redis` y `evolution-api`
- `.env` y `.env.example` ya fueron adaptados
- instancia `principal` ya creada con exito en `Evolution API`
- instancia `principal` ya conectada y en estado `open`
- webhook de `principal` ya persistido apuntando a `host.docker.internal`
- scripts listos:
  - [`scripts/dev/evolution-create-instance.sh`](/Users/juanpablovonmarttens/Documents/Automatización%20/crm-whatsapp-automatizado/scripts/dev/evolution-create-instance.sh)
  - [`scripts/dev/evolution-connect-instance.sh`](/Users/juanpablovonmarttens/Documents/Automatización%20/crm-whatsapp-automatizado/scripts/dev/evolution-connect-instance.sh)
  - [`scripts/dev/evolution-set-webhook.sh`](/Users/juanpablovonmarttens/Documents/Automatización%20/crm-whatsapp-automatizado/scripts/dev/evolution-set-webhook.sh)

Pendiente:

- mantener el QR/reconexion como procedimiento operativo, no como bloqueo actual

## Validacion Real End-to-End

Estado: completada a nivel funcional inicial.

Se valido con mensajes reales por WhatsApp que el sistema:

- recibe mensajes desde `Evolution API`
- ejecuta `WA - Inbound Entry`
- mantiene estado conversacional en PostgreSQL
- responde por WhatsApp
- crea lead en PostgreSQL
- asigna vendedor por round robin
- crea tarea en ClickUp

Evidencia de tareas ClickUp creadas durante pruebas reales:

- lead `14`
  - tarea ClickUp: `86ah3h2ew`
  - URL: `https://app.clickup.com/t/86ah3h2ew`
  - vendedor: `Valentina Rojas`
- lead `15`
  - tarea ClickUp: `86ah3h2m6`
  - URL: `https://app.clickup.com/t/86ah3h2m6`
  - vendedor: `Martina Perez`
- lead `16`
  - tarea ClickUp: `86ah3h2q6`
  - URL: `https://app.clickup.com/t/86ah3h2q6`
  - vendedor: `Camila Soto`

Notas de prueba:

- estos leads/tareas son datos de validacion y ya fueron revisados/marcados como prueba en ClickUp
- no deben considerarse oportunidades comerciales reales ni usarse para metricas de negocio
- durante la validacion se corrigieron loops conversacionales y problemas de interpretacion deterministica
- commits relevantes:
  - `65e1124 fix: handle initial whatsapp greetings`
  - `86eea4c fix: accept direct service answers`
  - `374df38 fix: prevent conversational loops`
  - `7103479 fix: reset previous context without reusing command`

Estado de limpieza de datos de prueba:

- leads `14`, `15` y `16` identificados como pruebas de validacion
- tareas ClickUp `86ah3h2ew`, `86ah3h2m6` y `86ah3h2q6` revisadas y marcadas/gestionadas como prueba
- queda pendiente no mezclar estos registros con reportes reales de operacion

## Siguiente paso recomendado

1. correr baseline local:
   - `sh scripts/dev/sync-n8n-workflows.sh --preflight`
   - `sh scripts/ops/test-ai-assistant-local.sh`
   - `sh scripts/ops/test-conversation-regression-local.sh`
   - healthcheck de `n8n`
2. sincronizar workflows y verificar que `WA - Inbound Entry` quede activo
3. ejecutar matriz conversacional con AI apagada
4. levantar el bridge OpenClaw con `OPENCLAW_AGENT=hormi-atencion`
5. confirmar que `.env` usa el mismo `OPENCLAW_BRIDGE_TOKEN` que el bridge
6. ejecutar matriz conversacional con AI encendida, incluyendo falla del bridge, baja confianza y respuesta invalida

## Siguiente fase planificada

Esta fase queda registrada para avanzar desde validacion funcional real hacia produccion, usando Hormi Atencion/OpenClaw como IA oficial y manteniendo fallback deterministico.

Decision sobre AI:

- se usara Hormi Atencion como asistente de extraccion, clasificacion, redaccion y confirmacion
- proveedor actual: OpenClaw local
- agente actual: `hormi-atencion`
- la regla operativa es: Hormi Atencion decide la conversacion; `n8n` y PostgreSQL ejecutan
- la AI no escribe directamente en PostgreSQL
- la AI no crea tareas en ClickUp fuera del workflow
- la AI no asigna vendedores fuera del round robin
- la creacion de lead sigue requiriendo `servicio + ciudad + requerimiento + confirmacion`

Prioridades recomendadas:

1. Agregar seguridad y estabilidad base:
   - validar que solo `Evolution API` pueda llamar al webhook
   - usar HMAC si queda soportado de forma simple, o un secreto/token compartido si resulta mas robusto para `n8n`
   - revisar secretos y credenciales
   - backup de PostgreSQL
   - backup del volumen de `n8n`
   - prueba de restauracion
   - validar `OPS - Error Handler` con un fallo controlado
2. Cargar o revisar datos reales minimos:
   - vendedores reales en PostgreSQL
   - numeros reales de WhatsApp
   - `clickup_user_id` de cada vendedor activo que deba recibir leads por ClickUp
3. Incorporar AI controlada para calificacion conversacional:
   - validar sub-workflow `AI - Lead Qualification Assistant`
   - enviar mensaje actual, estado conversacional, ultimos mensajes relevantes, datos ya detectados y lead previo si existe
   - exigir salida JSON estructurada
   - usar AI para entender intencion, detectar datos faltantes, sugerir respuesta y generar resumen para ClickUp
   - validar `confidence`, campos faltantes y reglas del flujo antes de crear lead
   - si falta informacion o hay baja confianza, preguntar o pedir aclaracion
   - no aceptar campos sugeridos con `confidence < 0.75`
   - mantener `should_create_lead=false` si falta confirmacion
4. Validar reintentos en APIs externas:
   - ClickUp
   - `Evolution API` saliente
   - notificacion al vendedor
   - registro del fallo final si los reintentos no resuelven el problema
5. Crear o ampliar smoke test end-to-end:
   - entrada simulada
   - conversacion
   - lead
   - ClickUp
   - ejecucion antes de cambios importantes
6. Agregar observabilidad simple:
   - mensajes procesados hoy
   - leads creados hoy
   - errores de las ultimas 24 horas
   - leads por vendedor
   - partir con consultas SQL o vista simple antes de Grafana
7. Agregar logging y correlation ID:
   - identificador trazable entre workflows, mensajes, lead y ClickUp
   - apoyo para diagnosticar fallos sin revisar manualmente cada ejecucion
8. Documentar operacion y limpieza:
    - runbook para reiniciar servicios
    - revisar logs
    - reconectar QR
    - correr backups
    - revisar errores
    - definir retencion de auditoria/logs mas adelante

Principio de orden:

- primero hacerlo funcionar con WhatsApp real
- despues protegerlo y asegurar recuperacion
- despues incorporar AI como capa controlada
- despues hacerlo resistente y observable
- finalmente escalarlo

Quedan para mas adelante, solo si el uso real lo justifica:

- agente autonomo completo
- Redis como buffer de negocio
- `n8n` en modo queue con workers
- Grafana completo
- optimizaciones avanzadas de base de datos

## Prompt sugerido para un nuevo chat

```text
Continúa este proyecto desde /Users/juanpablovonmarttens/Documents/Automatización /crm-whatsapp-automatizado. Lee primero README.md y docs/handoff-actual.md. Despues revisa docs/evolution-api.md, docs/n8n-workflows.md, docs/flujo-leads.md, docs/matriz-pruebas-conversacionales.md y n8n/workflows/. No leas ni imprimas .env. Usa .env.example, samples y mocks salvo que seas el integrador. Retoma desde el siguiente paso recomendado, manteniendo la regla: Hormi Atencion/OpenClaw decide la conversacion; n8n/PostgreSQL ejecutan persistencia, ClickUp y asignacion solo para leads confirmados.
```
