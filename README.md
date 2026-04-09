# CRM WhatsApp Automatizado

Base inicial del proyecto para automatizar la captura, calificacion, registro y asignacion de leads desde WhatsApp usando `n8n` self-hosted, `PostgreSQL` y `Docker Compose`.

## Estado actual

Se implementaron la estructura base, la infraestructura local, la base de datos inicial y la documentacion funcional correspondientes a las FASES 2 a 6.

En esta etapa:

- se definio la estructura de carpetas del proyecto
- se dejaron archivos base versionables
- se prepararon placeholders para infraestructura, seeds, samples y workflows
- se dejo `Docker Compose` operativo para `n8n` y `PostgreSQL`
- se implemento la base de datos inicial del CRM
- se separo la base interna de `n8n` de la base del CRM
- se documento el flujo funcional y la arquitectura de workflows
- no se implementaron todavia los workflows reales ni las integraciones externas

## Objetivo del proyecto

Construir una automatizacion mantenible para:

- recibir mensajes entrantes desde WhatsApp oficial
- calificar leads con un flujo conversacional guiado
- registrar leads en ClickUp
- asignar leads con round robin
- notificar al vendedor asignado
- dejar trazabilidad completa en PostgreSQL

## Estructura principal

```text
docs/                Documentacion funcional y operativa en espanol
infra/               Infraestructura base del proyecto
n8n/                 Workflows versionados y samples de integracion
db/                  Diseno, seeds y consultas de base de datos
scripts/             Utilidades de desarrollo y operacion
```

## Documentacion

- [Arquitectura](./docs/arquitectura.md)
- [Flujo de leads](./docs/flujo-leads.md)
- [Arquitectura n8n](./docs/n8n-workflows.md)
- [Base de datos](./docs/base-de-datos.md)
- [Integraciones](./docs/integraciones.md)
- [Configuracion ClickUp](./docs/clickup-configuracion.md)
- [Handoff Actual](./docs/handoff-actual.md)
- [Operacion local](./docs/operacion-local.md)

## Archivos clave

- `docker-compose.yml`: punto de entrada de la orquestacion local
- `.env.example`: plantilla de variables de entorno
- `n8n/workflows/`: workflows exportados y versionados
- `n8n/samples/`: payloads de ejemplo para pruebas y diseno
- `infra/postgres/migrations/`: migraciones versionadas

## Primer arranque local

1. Copia `.env.example` a `.env`.
2. Genera un valor seguro para `N8N_ENCRYPTION_KEY`.
3. Levanta el entorno con:

```bash
docker compose --env-file .env up -d
```

4. Abre `http://127.0.0.1:5678`.
5. En el primer inicio, `n8n` te pedira crear el usuario propietario de la instancia.

Puertos locales del proyecto:

- `n8n`: `127.0.0.1:5678`
- `PostgreSQL`: `127.0.0.1:5433`

Bases de datos locales:

- `crm_whatsapp`: base interna de `n8n`
- `crm_whatsapp_app`: base del CRM y la logica de negocio

## Siguiente paso sugerido

La siguiente implementacion recomendada es:

- construir los workflows reales en `n8n`
- definir queries SQL operativas por workflow
- preparar las credenciales e integraciones reales con WhatsApp y ClickUp
