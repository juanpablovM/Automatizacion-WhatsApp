# Init de PostgreSQL

Esta carpeta queda montada en `/docker-entrypoint-initdb.d` dentro del contenedor de `PostgreSQL`.

Su uso queda reservado para scripts de inicializacion que deban ejecutarse solo en el primer arranque de una base nueva.

En esta fase no se cargan scripts reales porque el esquema del proyecto aun no esta definido.
