# Operacion Local

## Objetivo

Documentar como levantar y operar el proyecto localmente en macOS con vistas a futura migracion a servidor.

## Requisitos previos

- Docker Desktop instalado y funcionando
- puerto `5678` libre en tu Mac
- puerto `5433` libre en tu Mac
- puerto `8080` libre en tu Mac

No necesitas instalar `n8n` ni `PostgreSQL` de forma nativa.

## Servicios locales

- `n8n`: `http://127.0.0.1:5678`
- `PostgreSQL`: `127.0.0.1:5433`
- `Evolution API`: `http://127.0.0.1:8080`

Los puertos publicados quedan ligados a `127.0.0.1`, por lo que son accesibles desde tu Mac y no quedan expuestos publicamente por defecto.

Nota:

- el proyecto usa `5433` en el host local para no interferir con una instalacion nativa de PostgreSQL ya presente en tu Mac
- dentro de Docker, el servicio `postgres` sigue usando el puerto interno `5432`

## Bases de datos usadas

- `crm_whatsapp`: base interna de `n8n`
- `crm_whatsapp_app`: base del CRM del proyecto
- `evolution_api`: base tecnica de `Evolution API`

Esta separacion mantiene desacopladas:

- la persistencia tecnica de `n8n`
- la persistencia funcional del negocio

## Preparacion inicial

1. Entra al proyecto:

```bash
cd /Users/juanpablovonmarttens/Documents/Automatización\ /crm-whatsapp-automatizado
```

2. Crea tu archivo local de entorno:

```bash
cp .env.example .env
```

3. Genera una clave segura para `N8N_ENCRYPTION_KEY`:

```bash
openssl rand -base64 32
```

4. Reemplaza en `.env`:

- `POSTGRES_PASSWORD`
- `N8N_ENCRYPTION_KEY`

## Levantar el entorno

```bash
docker compose --env-file .env up -d
```

## Verificar que arranco bien

```bash
docker compose --env-file .env ps
```

Para revisar logs:

```bash
docker compose --env-file .env logs -f n8n
docker compose --env-file .env logs -f postgres
docker compose --env-file .env logs -f evolution-api
docker compose --env-file .env logs -f redis
```

## Primer acceso a n8n

1. Abre `http://127.0.0.1:5678`.
2. En el primer inicio, `n8n` te pedira crear el usuario propietario de la instancia.
3. Ese usuario sera tu acceso administrativo local inicial.

## Sincronizar workflows de n8n

La fuente versionada esta en:

- `n8n/workflows/`
- `n8n/workflow-links.json`

Antes de importar, valida el estado local:

```bash
sh scripts/dev/sync-n8n-workflows.sh --preflight
```

Para sincronizar contra la instancia local:

```bash
sh scripts/dev/sync-n8n-workflows.sh
```

Este script importa con `n8n import:workflow` dentro del contenedor, resuelve IDs reales desde los nombres de workflows y verifica que `OPS - Error Handler` quede configurado como workflow de errores. No se debe actualizar `workflow_entity` manualmente.

Estado validado:

- los workflows versionados ya fueron importados
- `WA - Inbound Entry` queda activo para recibir el webhook
- los sub-workflows se ejecutan desde `WA - Inbound Entry`
- `OPS - Error Handler` queda configurado como workflow de errores

## Persistir webhook de Evolution API

Cuando cambie `EVOLUTION_WEBHOOK_URL`, `EVOLUTION_WEBHOOK_EVENTS` o `EVOLUTION_WEBHOOK_SECRET`, actualiza la configuracion persistida de la instancia:

```bash
sh scripts/dev/evolution-set-webhook.sh
```

## Redis de Evolution API

Redis queda habilitado por defecto desde `docker-compose.yml` y `.env.example` con:

- `EVOLUTION_REDIS_ENABLED=true`
- `EVOLUTION_SAVE_INSTANCES_IN_REDIS=true`

Si tu `.env` local fue creado antes, puede conservar `EVOLUTION_SAVE_INSTANCES_IN_REDIS=false`; en ese caso ese valor local prevalece. No se actualiza automaticamente porque `.env` contiene secretos reales.

## Persistencia

La persistencia se guarda en volumenes nombrados de Docker:

- `crm-whatsapp-automatizado_postgres_data`
- `crm-whatsapp-automatizado_n8n_data`
- `crm-whatsapp-automatizado_redis_data`
- `crm-whatsapp-automatizado_evolution_instances`

Esto permite reiniciar o recrear contenedores sin perder la informacion almacenada.

## Detener el entorno

```bash
docker compose --env-file .env down
```

Esto detiene los contenedores, pero no elimina los volumenes.

## Backup local

El proyecto incluye un script inicial para respaldar la base del CRM, la base interna de `n8n` y el volumen `n8n_data`:

```bash
sh scripts/ops/backup-local.sh
```

El resultado queda en `backups/<fecha>/`, fuera de Git. El restore todavia debe probarse de forma controlada antes de considerar el entorno recuperable para produccion.

Para verificar el ultimo backup sin tocar las bases reales:

```bash
sh scripts/ops/verify-backup-local.sh
```

Tambien puedes indicar un directorio especifico:

```bash
sh scripts/ops/verify-backup-local.sh backups/20260427-163804
```

## Probar error handler

Para validar que `OPS - Error Handler` recibe fallos reales desde n8n:

```bash
sh scripts/ops/test-error-handler.sh
```

El script envia un evento sintetico autorizado con timestamp invalido, espera la auditoria y muestra los ultimos errores registrados.

## Reintentos HTTP externos

Los workflows de ClickUp, notificacion interna y WhatsApp saliente usan retry con backoff para errores de red y estados `408`, `409`, `425`, `429`, `500`, `502`, `503` y `504`.

Variables:

- `EXTERNAL_HTTP_MAX_ATTEMPTS`
- `EXTERNAL_HTTP_RETRY_BASE_MS`
- `EXTERNAL_HTTP_RETRY_MAX_MS`

## AI Lead Assistant

El sub-workflow `AI - Lead Qualification Assistant` queda desactivado por defecto:

```bash
AI_LEAD_ASSISTANT_ENABLED=false
AI_PROVIDER=nvidia
AI_BASE_URL=https://integrate.api.nvidia.com/v1
AI_API_MODE=chat_completions
AI_API_KEY=__PENDIENTE__
AI_API_KEY_REQUIRED=true
AI_MODEL=minimaxai/minimax-m2.5
```

Para validar el contrato local sin llamar al proveedor real:

```bash
sh scripts/ops/test-ai-assistant-local.sh
```

Para usar NVIDIA API Catalog, crea una API key en `build.nvidia.com`, configura `AI_API_KEY`, activa `AI_LEAD_ASSISTANT_ENABLED=true`, recrea `n8n` con `docker compose --env-file .env up -d n8n` y ejecuta una prueba controlada. MiniMax M2.5 queda configurado con `AI_API_MODE=chat_completions`.

## Alcance actual

En esta fase ya puedes:

- levantar `n8n`
- levantar `PostgreSQL`
- levantar `Evolution API`
- acceder al editor de `n8n`
- validar conectividad local entre servicios
- crear o revisar una instancia local de `Evolution API`
- solicitar QR o pairing data para reconexion
- recibir mensajes reales desde la instancia conectada
- crear leads en PostgreSQL
- crear tareas en ClickUp desde leads confirmados
- notificar al vendedor en ClickUp

Antes de considerar el entorno listo para produccion falta:

- probar restore antes de confiar en los backups
- operar multiples instancias con una estrategia final documentada
- considerar produccion lista sin backup/restore probado

## Pendientes

- documentar el procedimiento operativo de reconexion QR
- activar y probar el secreto del webhook antes de cualquier exposicion publica
- probar restore desde un backup local
