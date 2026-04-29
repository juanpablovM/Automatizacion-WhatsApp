# Init de PostgreSQL

Esta carpeta queda montada en `/docker-entrypoint-initdb.d` dentro del contenedor de `PostgreSQL`.

Su uso queda reservado para scripts de inicializacion que deban ejecutarse solo en el primer arranque de una base nueva.

El esquema del CRM ya existe en `infra/postgres/migrations/` y se ejecuta manualmente o mediante el procedimiento operativo definido para migraciones.

Esta carpeta se mantiene vacia a proposito porque los archivos montados aqui corren solo en el primer arranque del volumen de PostgreSQL. Para cambios versionados del esquema, usar migraciones.
