# Evolution API

## Objetivo

Documentar la adaptacion del proyecto para usar `Evolution API` como capa de WhatsApp self-hosted, manteniendo intacta la logica CRM ya implementada.

## Componentes agregados

- `redis` como dependencia operativa de `Evolution API`
- `evolution-api` como servicio self-hosted de WhatsApp
- base `evolution_api` dentro del mismo `PostgreSQL`

## Puertos locales

- `Evolution API`: `http://127.0.0.1:8080`

## Variables principales

- `EVOLUTION_SERVER_URL`
- `EVOLUTION_API_BASE_URL`
- `EVOLUTION_API_KEY`
- `EVOLUTION_DEFAULT_INSTANCE`
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

- `http://host.docker.internal:5678/webhook/mXz1XhLO0cd9PME6/evolutionwebhook/wa-inbound-entry`

Este valor funciona bien en Docker Desktop para macOS porque `Evolution API` puede alcanzar el puerto publicado de `n8n` a traves de `host.docker.internal`, sin exponer el webhook a internet.

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
