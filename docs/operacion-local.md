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

Ambos puertos se publican solo en `127.0.0.1`, por lo que quedan accesibles desde tu Mac y no expuestos publicamente por defecto.

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

## Alcance actual

En esta fase ya puedes:

- levantar `n8n`
- levantar `PostgreSQL`
- levantar `Evolution API`
- acceder al editor de `n8n`
- validar conectividad local entre servicios
- crear una instancia local de `Evolution API`
- solicitar el QR del numero a conectar

En esta fase todavia no puedes:

- recibir webhooks reales desde internet sin exponer el entorno
- operar multiples instancias sin definir la estrategia final

## Pendientes

- exponer el entorno a internet si quieres usar webhooks fuera de Docker local
- documentar el alta operativa del primer numero conectado
