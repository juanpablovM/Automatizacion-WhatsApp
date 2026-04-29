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
- ClickUp ya validado con tarea real:
  - `86agtc6z3`
  - `https://app.clickup.com/t/86agtc6z3`

Lo que aun falta cerrar:

- implementar seguridad y recuperacion minima antes de incorporar AI

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
- `EVOLUTION_WEBHOOK_SECRET=...`
- `EVOLUTION_WEBHOOK_URL=http://host.docker.internal:5678/webhook/mXz1XhLO0cd9PME6/evolutionwebhook/wa-inbound-entry?token=<EVOLUTION_WEBHOOK_SECRET>`
- `EVOLUTION_REDIS_ENABLED=true`
- `EVOLUTION_SAVE_INSTANCES_IN_REDIS=true`
- `CLICKUP_API_TOKEN=...`
- `CLICKUP_LIST_ID=901326797183`
- `CLICKUP_TEAM_ID=9013271719`
- `CLICKUP_CF_*` ya cargados en `.env`

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

## Decisiones funcionales ya cerradas

- canal de entrada funcional: WhatsApp
- proveedor actual elegido: `Evolution API`
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

## Workflows existentes en n8n

Ya importados:

- `WA - Inbound Entry`
- `WA - Conversation Orchestrator`
- `WA - Outbound Messages`
- `CRM - Lead Creation And Assignment`
- `CRM - ClickUp Sync Lead`
- `CRM - Seller Notification Dispatch`
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
- `WA - Conversation Orchestrator`
  - lectura de contexto, evaluacion conversacional, confirmacion, persistencia y salida combinada
- `WA - Outbound Messages`
  - encola mensaje saliente
  - usa endpoint `sendText` de `Evolution API`
  - persiste resultado de entrega y auditoria
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

1. cerrar recuperacion minima:
   - definir si basta la verificacion no destructiva de restore o si se hara restore completo en entorno aislado
2. validar reintentos con fallos externos reales o simulados
3. validar `AI - Lead Qualification Assistant` con NVIDIA NIM u otro proveedor compatible con OpenAI y conectarlo al orquestador como capa controlada

## Siguiente fase planificada

Esta fase queda registrada para ejecutarse despues de cualquier trabajo previo que se decida hacer antes. El orden recomendado es avanzar desde validacion funcional real hacia produccion, incorporando AI como una capa controlada de comprension conversacional y sin saltar directo a optimizaciones avanzadas.

Decision sobre AI:

- se incorporara AI como asistente de extraccion, clasificacion y redaccion
- no se partira con un agente autonomo completo
- la regla operativa es: AI recomienda, `n8n` y PostgreSQL deciden
- la AI no escribe directamente en PostgreSQL
- la AI no crea tareas en ClickUp por si sola
- la AI no asigna vendedores
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
Continúa este proyecto desde /Users/juanpablovonmarttens/Documents/Automatización /crm-whatsapp-automatizado. Lee primero README.md y docs/handoff-actual.md. Despues revisa docs/evolution-api.md, docs/n8n-workflows.md, docs/flujo-leads.md y n8n/workflows/. Retoma desde el siguiente paso recomendado y no asumas nada fuera de lo documentado.
```
