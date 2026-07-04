# Init de PostgreSQL

Esta carpeta queda montada en `/docker-entrypoint-initdb.d` dentro del contenedor de `PostgreSQL`.

Su uso queda reservado para scripts de inicializacion que deban ejecutarse solo en el primer arranque de una base nueva.

El esquema del CRM ya existe en `infra/postgres/migrations/` y se ejecuta manualmente o mediante el procedimiento operativo definido para migraciones.

Uso actual de esta carpeta:

- `001_create_default_databases.sql`: crea `crm_whatsapp_app` y `evolution_api` si el volumen es nuevo

Regla:

- usar `infra/postgres/init/` solo para bootstrap de un volumen nuevo
- usar `infra/postgres/migrations/` para cualquier cambio versionado del esquema de negocio
