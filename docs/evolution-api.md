# Evolution API

## Objetivo

Documentar la adaptacion del proyecto para usar `Evolution API` como capa de WhatsApp self-hosted, manteniendo intacta la logica CRM ya implementada.

## Componentes agregados

- `redis` como dependencia operativa de `Evolution API`
- `evolution-api` como servicio self-hosted de WhatsApp
- base `evolution_api` dentro del mismo `PostgreSQL`

## Puertos locales

- `Evolution API`: `http://127.0.0.1:8080`

## Estado actual

La integracion con `Evolution API` ya fue validada con WhatsApp real.

Estado observado en la ultima validacion:

- imagen configurada: `evoapicloud/evolution-api:v2.3.7`
- runtime API: `2.3.7`
- instancia default: `principal`
- estado de `principal`: `open`
- webhook persistido hacia `n8n`
- evento operativo: `MESSAGES_UPSERT`

El script `scripts/dev/evolution-doctor.sh` es la forma recomendada de confirmar este estado antes de una prueba.

## Variables principales

- `EVOLUTION_SERVER_URL`
- `EVOLUTION_API_BASE_URL`
- `EVOLUTION_API_KEY`
- `EVOLUTION_DEFAULT_INSTANCE`
- `EVOLUTION_WEBHOOK_SECRET`
- `EVOLUTION_WEBHOOK_URL`
- `EVOLUTION_WEBHOOK_EVENTS`
- `EVOLUTION_POSTGRES_DB`
- `EVOLUTION_REDIS_ENABLED`
- `EVOLUTION_SAVE_INSTANCES_IN_REDIS`

Redis queda habilitado por defecto para Evolution API:

- `CACHE_REDIS_ENABLED=${EVOLUTION_REDIS_ENABLED:-true}`
- `CACHE_REDIS_SAVE_INSTANCES=${EVOLUTION_SAVE_INSTANCES_IN_REDIS:-true}`

Esto mantiene las sesiones de WhatsApp desacopladas del cache local del contenedor y mejora la estabilidad al reiniciar servicios.

Si `.env` ya existia antes de este cambio, revisar que no mantenga el valor antiguo `EVOLUTION_SAVE_INSTANCES_IN_REDIS=false`. El proyecto no modifica `.env` automaticamente para evitar tocar secretos locales.

## Versiones y compatibilidad

- usar imagen fija en `EVOLUTION_API_IMAGE`:
  - `evoapicloud/evolution-api:v2.3.7`
- evitar `atendai/evolution-api:latest`:
  - deja la version flotante y puede resolver una release antigua (`v2.2.x`)
  - genera quiebres silenciosos por cambios de compatibilidad entre versiones

### Diagnostico rapido

```bash
sh scripts/dev/evolution-doctor.sh
```

Este script valida:

- version runtime de Evolution API
- imagen configurada en `.env`
- existencia de la instancia default (`EVOLUTION_DEFAULT_INSTANCE`)

## Webhook usado por n8n

`Evolution API` debe apuntar a:

- `http://host.docker.internal:5678/webhook/<WA_INBOUND_WORKFLOW_ID>/evolutionwebhook/wa-inbound-entry?token=<EVOLUTION_WEBHOOK_SECRET>`

Este valor funciona bien en Docker Desktop para macOS porque `Evolution API` puede alcanzar el puerto publicado de `n8n` a traves de `host.docker.internal`, sin exponer el webhook a internet.
En Docker Compose local tambien puede usarse `http://n8n:5678/...`. El ID real se obtiene despues de sincronizar workflows; no reutilices IDs de instalaciones anteriores.

La validacion del secreto queda inactiva si `EVOLUTION_WEBHOOK_SECRET` esta vacio. En el entorno local actual ya quedo configurado un valor real en `.env` y el webhook de `principal` fue repersistido con `?token=<redacted>`.

## Estrategia de instancias

- una instancia representa un numero conectado
- el proyecto deja una instancia por defecto:
  - `principal`
- a futuro pueden coexistir varias instancias sin cambiar la logica CRM

## Scripts incluidos

### Crear instancia

```bash
sh scripts/dev/evolution-create-instance.sh
```

Opcionalmente:

```bash
sh scripts/dev/evolution-create-instance.sh nombre-instancia token-opcional
```

### Solicitar QR o pairing data

```bash
sh scripts/dev/evolution-connect-instance.sh
```

Opcionalmente:

```bash
sh scripts/dev/evolution-connect-instance.sh nombre-instancia
```

Procedimiento de reconexion:

1. Revisar estado:

```bash
sh scripts/dev/evolution-doctor.sh
```

2. Si la instancia no existe, crearla:

```bash
sh scripts/dev/evolution-create-instance.sh
```

3. Solicitar QR o pairing data:

```bash
sh scripts/dev/evolution-connect-instance.sh
```

4. Escanear el QR desde WhatsApp o completar el pairing.

5. Verificar que la instancia quede `open` y repersistir webhook:

```bash
sh scripts/dev/evolution-doctor.sh
sh scripts/dev/evolution-set-webhook.sh
```

No usar borrado de volumenes ni eliminar la instancia para una reconexion normal. Eso queda reservado para reset deliberado de sesion.

### Persistir webhook

```bash
sh scripts/dev/evolution-set-webhook.sh
```

El script toma `EVOLUTION_WEBHOOK_URL`, `EVOLUTION_WEBHOOK_EVENTS` y, si existe, `EVOLUTION_WEBHOOK_SECRET`. Si el secreto esta configurado pero la URL no trae `token` ni `secret`, agrega `?token=<EVOLUTION_WEBHOOK_SECRET>` antes de enviarla a Evolution API.

## Eventos configurados

Por defecto:

- `MESSAGES_UPSERT`

Este evento alimenta el workflow [`WA - Inbound Entry`](/Users/juanpablovonmarttens/Documents/Automatización%20/crm-whatsapp-automatizado/n8n/workflows/wa-inbound-entry.json).

## Workflows adaptados

- [`WA - Inbound Entry`](/Users/juanpablovonmarttens/Documents/Automatización%20/crm-whatsapp-automatizado/n8n/workflows/wa-inbound-entry.json)
- [`WA - Conversation Orchestrator`](/Users/juanpablovonmarttens/Documents/Automatización%20/crm-whatsapp-automatizado/n8n/workflows/wa-conversation-orchestrator.json)
- [`WA - Outbound Messages`](/Users/juanpablovonmarttens/Documents/Automatización%20/crm-whatsapp-automatizado/n8n/workflows/wa-outbound-messages.json)

## Cambio de alcance

No cambia:

- `PostgreSQL`
- `ClickUp`
- calificacion del lead
- round robin
- auditoria
- modelo CRM

Solo cambia:

- capa de entrada y salida de WhatsApp
- variables de entorno de WhatsApp
- servicio de infraestructura del canal

## Pendientes

- definir estrategia para multiples instancias si se operan varios numeros
