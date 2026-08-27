# Operacion Local

## Objetivo

Documentar como levantar y operar el proyecto localmente en macOS con vistas a futura migracion a servidor.

## Estado observado al 2026-06-30

En la revision operativa de esa fecha se observo:

- stack local arriba y healthy
- `wahormiglass` en estado `open`
- `sync-n8n-workflows.sh --preflight` en `OK`
- `test-ai-assistant-local.sh` en `OK`
- `test-conversation-regression-local.sh` en `OK`
- `verify-backup-local.sh` en `OK` sobre el backup post-sync autorizado

Tambien se detectaron riesgos abiertos:

- errores historicos en `audit_logs`
- mensajes salientes historicos con `delivery_status='failed'`
- un vendedor de pruebas aun activo en round robin
- casos de continuidad donde se contaminaron campos comerciales

Para el detalle, revisar [`docs/estado-actual-2026-06-30.md`](./estado-actual-2026-06-30.md).

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

El `docker-compose.yml` publica estos puertos en `0.0.0.0` mediante variables de entorno. En una maquina local se consumen por `127.0.0.1`; antes de mover el stack a staging o produccion hay que restringirlos con firewall, redes privadas y reverse proxy.

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
cd /home/agentesai/Automatizacion-WhatsApp
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

Nota:

- que un workflow aparezca `inactive` en `workflow_entity` no implica que este fuera de uso si es sub-workflow invocado mediante `Execute Workflow`

El procedimiento operativo completo esta en [`runbook-operacion.md`](./runbook-operacion.md).

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

El proyecto incluye un script para respaldar la base del CRM, la base interna de `n8n` y el volumen `n8n_data`:

```bash
sh scripts/ops/backup-local.sh
```

El resultado queda en `backups/<fecha>/`, fuera de Git.

Para verificar el ultimo backup sin tocar las bases reales:

```bash
sh scripts/ops/verify-backup-local.sh
```

En el cierre P0 del `2026-06-30`, esta verificacion paso correctamente sobre el backup post-sync `backups/20260630-145829/`.
Ese directorio queda como punto de restauracion autorizado para el baseline local actual.

Esta verificacion crea bases temporales `*_restore_check_<timestamp>`, restaura los dumps ahi, valida conteos basicos y elimina esas bases al terminar. No es un restore destructivo sobre las bases reales.

Tambien puedes indicar un directorio especifico:

```bash
sh scripts/ops/verify-backup-local.sh backups/20260427-163804
```

## Probar error handler

Para validar que `OPS - Error Handler` recibe fallos reales desde n8n:

```bash
sh scripts/ops/test-error-handler.sh
```

El script envia un evento sintetico autorizado con la bandera interna `__force_error_handler_test`, espera la auditoria y muestra los ultimos errores registrados.

## Reintentos HTTP externos

Los workflows de ClickUp, notificacion interna y WhatsApp saliente usan retry con backoff para errores de red y estados `408`, `409`, `425`, `429`, `500`, `502`, `503` y `504`.

Variables:

- `EXTERNAL_HTTP_MAX_ATTEMPTS`
- `EXTERNAL_HTTP_RETRY_BASE_MS`
- `EXTERNAL_HTTP_RETRY_MAX_MS`

## AI Lead Assistant

La plantilla local mantiene Hormi Atencion por API directa activado por defecto. Para operar con AI real, configurar API key y modelo en `.env`, y recrear `n8n`:

```bash
AI_DIRECT_API_KEY=<redacted>
AI_DIRECT_API_MODEL=gemini-3.1-flash-lite
docker compose --env-file .env up -d n8n
```

Valor canónico actual: `gemini-3.1-flash-lite`.
Si se necesita mas calidad, evaluar `gemini-3.5-flash` como prueba controlada; no dejar `preview` ni `latest` como default.

Para validar el contrato local sin llamar al proveedor real:

```bash
sh scripts/ops/test-ai-assistant-local.sh
```

La prueba local valida contrato y fallback con respuestas simuladas en memoria. Cubre: saludo, lead completo sin confirmacion, lead completo con confirmacion, correccion del usuario, mensaje ambiguo de baja confianza, respuesta invalida del proveedor y error de configuracion. No usa `.env` real ni llama al proveedor AI.

Diagnostico de autenticacion:

- Confirmar que `AI_DIRECT_API_KEY` y `AI_DIRECT_API_MODEL` no siguen en `__PENDIENTE__`.
- Confirmar que `AI_DIRECT_API_BASE_URL` y `AI_DIRECT_API_PATH` apuntan al proveedor elegido.
- Confirmar que `n8n` fue recreado despues de cambiar `.env`.
- Si el proveedor devuelve `401`, revisar la API key sin imprimirla en logs.

Guardrails actuales del sub-workflow:

- `should_create_lead` solo puede quedar `true` con datos criticos, confirmacion aplicable y `confidence >= 0.75`.
- si falta confirmacion, `missing_fields` incluye `confirmation` y el resumen ClickUp queda vacio.
- si `confidence < 0.75`, no se aceptan campos nuevos sugeridos por AI; solo se conservan campos ya existentes en el contexto.
- si la respuesta del proveedor AI no contiene JSON valido, se devuelve fallback seguro con `should_create_lead=false`.
- `field_updates` se validan antes de persistirse.
- `pending_question_key` controla la interpretacion de respuestas breves.
- no se anuncia derivacion antes de contar con `lead_id`.

Variables esperadas en `.env`:

```bash
AI_PROVIDER=google
AI_API_KEY_REQUIRED=true
AI_DIRECT_API_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai
AI_DIRECT_API_PATH=/chat/completions
AI_DIRECT_API_KEY=__PENDIENTE__
AI_DIRECT_API_MODEL=gemini-3.1-flash-lite
AI_DIRECT_API_TIMEOUT_MS=120000
```

El sub-workflow tambien soporta `/responses`; el valor versionado en `.env.example` es `/chat/completions`, y el test local de contrato puede ejercitar cualquiera de las dos formas sin salir a internet.

La guia vigente esta en [`docs/ai-api-directa-configuracion.md`](./ai-api-directa-configuracion.md).

Regla de seguridad: Hormi Atencion decide la conversacion y puede habilitar un lead confirmado; `n8n` y PostgreSQL validan memoria, guardrails, persistencia, ClickUp y asignacion.

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

- ejecutar matriz E2E completa despues de cada cambio de AI/orquestador
- operar multiples instancias con una estrategia final documentada
- validar restore completo en entorno aislado si se requiere recuperacion total, no solo verify restore no destructivo

## Pendientes

- definir estrategia para multiples instancias si se operan varios numeros
- validar restore completo en entorno aislado antes de declarar produccion recuperable
