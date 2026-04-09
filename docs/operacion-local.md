# Operacion Local

## Objetivo

Documentar como levantar y operar el proyecto localmente en macOS con vistas a futura migracion a servidor.

## Requisitos previos

- Docker Desktop instalado y funcionando
- puerto `5678` libre en tu Mac
- puerto `5433` libre en tu Mac

No necesitas instalar `n8n` ni `PostgreSQL` de forma nativa.

## Servicios locales

- `n8n`: `http://127.0.0.1:5678`
- `PostgreSQL`: `127.0.0.1:5433`

Ambos puertos se publican solo en `127.0.0.1`, por lo que quedan accesibles desde tu Mac y no expuestos publicamente por defecto.

Nota:

- el proyecto usa `5433` en el host local para no interferir con una instalacion nativa de PostgreSQL ya presente en tu Mac
- dentro de Docker, el servicio `postgres` sigue usando el puerto interno `5432`

## Bases de datos usadas

- `crm_whatsapp`: base interna de `n8n`
- `crm_whatsapp_app`: base del CRM del proyecto

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
```

## Primer acceso a n8n

1. Abre `http://127.0.0.1:5678`.
2. En el primer inicio, `n8n` te pedira crear el usuario propietario de la instancia.
3. Ese usuario sera tu acceso administrativo local inicial.

## Persistencia

La persistencia se guarda en volumenes nombrados de Docker:

- `crm-whatsapp-automatizado_postgres_data`
- `crm-whatsapp-automatizado_n8n_data`

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
- acceder al editor de `n8n`
- validar conectividad local entre servicios

En esta fase todavia no puedes:

- recibir webhooks reales de WhatsApp desde internet
- crear leads reales en ClickUp
- ejecutar el CRM automatizado completo

## Pendientes

- definir migraciones reales
- modelar tablas y seeds
- preparar la futura exposicion publica de webhooks
