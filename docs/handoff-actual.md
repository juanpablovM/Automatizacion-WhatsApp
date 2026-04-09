# Handoff Actual

## Objetivo de este documento

Permitir retomar el proyecto en un chat nuevo sin depender del historial conversacional anterior.

Este archivo debe leerse al inicio de una nueva sesion de trabajo.

## Como usar este handoff en un chat nuevo

Al abrir una nueva sesion:

1. indicar la ruta del proyecto
2. pedir que se lean primero `README.md` y este archivo
3. pedir despues la lectura puntual de los documentos tecnicos necesarios
4. indicar explicitamente el siguiente paso que debe retomarse

Prompt recomendado:

```text
Continúa este proyecto desde /Users/juanpablovonmarttens/Documents/Automatización /crm-whatsapp-automatizado. Lee primero README.md y docs/handoff-actual.md. Despues revisa docs/n8n-workflows.md, docs/flujo-leads.md y db/queries/n8n/. Retoma desde el siguiente paso recomendado y no asumas nada fuera de lo documentado.
```

## Estado actual del proyecto

El proyecto ya tiene implementadas las bases de:

- estructura versionable del repo
- infraestructura local con `Docker Compose`
- `n8n` self-hosted funcionando localmente
- `PostgreSQL` funcionando localmente
- base de datos del CRM inicial ya creada
- separacion entre base interna de `n8n` y base del CRM
- flujo funcional documentado
- arquitectura de workflows documentada
- workflows base importados en `n8n`
- credencial PostgreSQL del CRM creada dentro de `n8n`
- libreria de queries SQL por workflow versionada en el repo

## Resumen ejecutivo rapido

Hoy el proyecto ya tiene:

- infraestructura local funcional
- `n8n` accesible en navegador
- `PostgreSQL` operativo
- base CRM separada de la base interna de `n8n`
- modelo de datos inicial creado y sembrado
- workflows base importados en `n8n`
- credencial PostgreSQL ya creada en `n8n`

Lo que aun no esta operativo de punta a punta:

- queries reales conectadas dentro de cada workflow
- integracion real con ClickUp
- integracion real con WhatsApp Cloud API
- campos reales de ClickUp e IDs reales en variables de entorno

## Ruta de trabajo

Proyecto:

- `/Users/juanpablovonmarttens/Documents/Automatización /crm-whatsapp-automatizado`

## Infraestructura local

### Servicios Docker

- `n8n`
  - URL: `http://localhost:5678`
- `postgres`
  - host local: `127.0.0.1`
  - puerto local: `5433`

### Estado esperado

Comprobar con:

```bash
cd "/Users/juanpablovonmarttens/Documents/Automatización /crm-whatsapp-automatizado"
docker compose --env-file .env ps
```

## Bases de datos

### Base interna de n8n

- nombre: `crm_whatsapp`
- uso: tablas internas de `n8n`

### Base del CRM

- nombre: `crm_whatsapp_app`
- uso: dominio del negocio

Tablas principales del CRM:

- `whatsapp_numbers`
- `leads`
- `conversations`
- `messages`
- `message_attachments`
- `sellers`
- `assignment_rotations`
- `lead_assignments`
- `lead_statuses`
- `conversation_statuses`
- `audit_logs`

## Variables y archivos importantes

### Variables de entorno

Archivo local:

- `.env`

Plantilla:

- `.env.example`

Variables importantes ya contempladas:

- `POSTGRES_DB=crm_whatsapp`
- `APP_POSTGRES_DB=crm_whatsapp_app`
- `POSTGRES_PASSWORD=...`
- `WHATSAPP_ACCESS_TOKEN=__PENDIENTE__`
- `WHATSAPP_PHONE_NUMBER_ID=__PENDIENTE__`
- `WHATSAPP_VERIFY_TOKEN=__PENDIENTE__`
- `WHATSAPP_BUSINESS_ACCOUNT_ID=__PENDIENTE__`
- `CLICKUP_API_TOKEN=__PENDIENTE__`
- `CLICKUP_LIST_ID=__PENDIENTE__`
- `CLICKUP_TEAM_ID=__PENDIENTE__`
- placeholders `CLICKUP_CF_*` para custom fields

## Documentacion clave

Leer al retomar:

- [`README.md`](/Users/juanpablovonmarttens/Documents/Automatización%20/crm-whatsapp-automatizado/README.md)
- [`docs/arquitectura.md`](/Users/juanpablovonmarttens/Documents/Automatización%20/crm-whatsapp-automatizado/docs/arquitectura.md)
- [`docs/flujo-leads.md`](/Users/juanpablovonmarttens/Documents/Automatización%20/crm-whatsapp-automatizado/docs/flujo-leads.md)
- [`docs/base-de-datos.md`](/Users/juanpablovonmarttens/Documents/Automatización%20/crm-whatsapp-automatizado/docs/base-de-datos.md)
- [`docs/n8n-workflows.md`](/Users/juanpablovonmarttens/Documents/Automatización%20/crm-whatsapp-automatizado/docs/n8n-workflows.md)
- [`docs/clickup-configuracion.md`](/Users/juanpablovonmarttens/Documents/Automatización%20/crm-whatsapp-automatizado/docs/clickup-configuracion.md)

## Decisiones funcionales ya cerradas

- canal de entrada: WhatsApp oficial
- flujo guiado con extraccion de contexto libre
- preguntas base:
  - servicio
  - ciudad
  - requerimiento
- criterio de creacion de lead:
  - `2 de 3 + intencion real`
- si falla comprension dos veces:
  - se crea lead igual
  - se deriva como parcial
- duplicados:
  - mismo telefono
  - retoma conversacion dentro de 24 horas
  - despues de 24 horas puede crear nuevo lead enlazado al anterior
- asignacion:
  - round robin secuencial simple
- notificacion:
  - WhatsApp interno como canal principal
  - respaldo operativo en ClickUp
- errores:
  - ClickUp con reintentos y estado de error si falla
  - PostgreSQL debe cortar el flujo si no persiste

## Decisiones tecnicas ya cerradas

- `n8n` como orquestador
- `PostgreSQL` como fuente de verdad del dominio
- varias workflows separadas
- uso hibrido de extraccion:
  - deterministica primero
  - IA como capa complementaria futura
- base de `n8n` separada de la base del CRM
- queries SQL versionadas por workflow

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

## Credenciales existentes en n8n

Ya creada:

- `Postgres CRM App Local`

Apunta a:

- host: `postgres`
- port: `5432`
- database: `crm_whatsapp_app`
- user: `postgres`

Pendientes:

- credencial HTTP/REST para WhatsApp Cloud API
- credencial HTTP/REST para ClickUp API

## SQL ya preparado

Libreria de queries:

- [`db/queries/n8n/`](/Users/juanpablovonmarttens/Documents/Automatización%20/crm-whatsapp-automatizado/db/queries/n8n)

Piezas ya preparadas:

- contexto conversacional
- insercion de mensajes
- metadata de adjuntos
- creacion de lead
- round robin
- asignacion
- carga de contexto para ClickUp
- carga de contexto para notificacion
- auditoria y manejo de error

## ClickUp

Ya esta definida la configuracion recomendada en:

- [`docs/clickup-configuracion.md`](/Users/juanpablovonmarttens/Documents/Automatización%20/crm-whatsapp-automatizado/docs/clickup-configuracion.md)

Pendiente:

- crear lista real `Leads Entrantes`
- crear custom fields reales
- obtener IDs reales
- completar variables `CLICKUP_*`

## WhatsApp

Pendiente:

- crear o configurar cuenta de WhatsApp Cloud API
- definir webhook real
- completar variables `WHATSAPP_*`

## Siguiente paso recomendado

El siguiente trabajo recomendado es:

1. reemplazar los `SELECT 1;` de los workflows importados por queries reales desde `db/queries/n8n/`
2. despues conectar ClickUp real
3. luego conectar WhatsApp Cloud API

Orden mas recomendable:

1. `WA - Conversation Orchestrator`
2. `CRM - Lead Creation And Assignment`
3. `CRM - ClickUp Sync Lead`
4. `WA - Outbound Messages`
5. `CRM - Seller Notification Dispatch`
6. `OPS - Error Handler`
7. `WA - Inbound Entry`

## Prompt sugerido para un nuevo chat

Si se abre un chat nuevo, usar algo como:

`Continúa este proyecto desde /Users/juanpablovonmarttens/Documents/Automatización /crm-whatsapp-automatizado. Lee README.md, docs/handoff-actual.md, docs/n8n-workflows.md, docs/flujo-leads.md y db/queries/n8n/. Retoma desde el siguiente paso recomendado: reemplazar los SELECT 1; por queries reales en los workflows de n8n.`

## Buenas practicas para no perder continuidad

- mantener este archivo actualizado al cierre de cada bloque importante
- dejar cualquier decision nueva tambien reflejada en `docs/`
- versionar cambios en Git con frecuencia
- no depender de la memoria del chat para decisiones tecnicas o funcionales
