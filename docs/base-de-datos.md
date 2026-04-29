# Base de Datos

## Objetivo

Documentar el diseno de persistencia del proyecto y su evolucion mediante migraciones.

## Estado actual

La base inicial ya fue implementada en migraciones SQL versionadas y seeds de catalogos. En el entorno local validado ya existen datos operativos de prueba generados por la validacion real del flujo WhatsApp -> ClickUp.

La arquitectura de persistencia queda separada asi:

- `crm_whatsapp`: base interna de `n8n`
- `crm_whatsapp_app`: base del CRM y la automatizacion de negocio

## Principios aplicados

- `PostgreSQL` como base principal
- modelo extensible desde el inicio
- separacion clara entre leads, conversaciones, mensajes, asignaciones, vendedores y auditoria
- borrado logico
- convencion tecnica en ingles con `snake_case` y plural
- estados con `code` tecnico en ingles y `label` operativo en espanol

## Estructura del proyecto relacionada

- `infra/postgres/migrations/`: migraciones versionadas
- `db/schema/`: documentacion del modelo
- `db/seeds/`: datos iniciales versionados
- `db/queries/`: consultas utiles de operacion y soporte

## Migraciones implementadas

- `001_create_status_catalogs.sql`
  - crea la funcion `set_updated_at()`
  - crea `lead_statuses`
  - crea `conversation_statuses`

- `002_create_operational_tables.sql`
  - crea `whatsapp_numbers`
  - crea `sellers`
  - crea `assignment_rotations`
  - crea `leads`
  - crea `conversations`
  - crea `messages`
  - crea `message_attachments`
  - crea `lead_assignments`
  - crea `audit_logs`

- `003_create_indexes.sql`
  - crea indices operativos
  - crea unicidad parcial para registros activos

## Seeds implementados

- `001_lead_statuses.sql`
- `002_conversation_statuses.sql`

## Dominios cubiertos por la base actual

- leads historicos por telefono
- conversaciones separadas del lead
- mensajes entrantes y salientes con payload crudo
- metadata de adjuntos
- vendedores y round robin persistente
- historial de asignaciones
- auditoria general
- catalogos de estados

## Estado runtime observado

En el entorno local usado para validacion existen registros reales de prueba:

- leads creados por el flujo
- conversaciones con estado `waiting_user` y `handed_to_sales`
- mensajes entrantes y salientes
- vendedores cargados para round robin
- auditorias de conversacion, ClickUp, notificacion y envio Evolution

Los datos de validacion no deben usarse como metricas comerciales.

## Documentacion complementaria

- [Resumen del esquema](../db/schema/overview.md)

## Ejecucion prevista

Orden esperado cuando el entorno local ya este levantado:

1. ejecutar migraciones de `infra/postgres/migrations/`
2. ejecutar seeds de `db/seeds/`

### Comandos manuales sugeridos

Con `PostgreSQL` ya levantado en Docker:

```bash
docker compose --env-file .env exec -T postgres \
  psql -U postgres -d crm_whatsapp_app -f infra/postgres/migrations/001_create_status_catalogs.sql

docker compose --env-file .env exec -T postgres \
  psql -U postgres -d crm_whatsapp_app -f infra/postgres/migrations/002_create_operational_tables.sql

docker compose --env-file .env exec -T postgres \
  psql -U postgres -d crm_whatsapp_app -f infra/postgres/migrations/003_create_indexes.sql

docker compose --env-file .env exec -T postgres \
  psql -U postgres -d crm_whatsapp_app -f db/seeds/001_lead_statuses.sql

docker compose --env-file .env exec -T postgres \
  psql -U postgres -d crm_whatsapp_app -f db/seeds/002_conversation_statuses.sql
```

Estos comandos suponen que mantienes los valores por defecto de `.env` para:

- `POSTGRES_USER=postgres`
- `POSTGRES_DB=crm_whatsapp`
- `APP_POSTGRES_DB=crm_whatsapp_app`

## Pendientes

- automatizar la ejecucion de migraciones y seeds si mas adelante lo apruebas
- revisar o reemplazar vendedores de prueba por vendedores reales antes de operar comercialmente
- cargar o documentar numeros reales de WhatsApp si se operaran multiples numeros
- documentar consultas operativas iniciales
- probar restore desde los backups generados por `scripts/ops/backup-local.sh`; existe verificacion no destructiva en `scripts/ops/verify-backup-local.sh`
