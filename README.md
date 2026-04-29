# CRM WhatsApp Automatizado

Proyecto para automatizar la captura, calificacion, registro y asignacion de leads desde WhatsApp usando `n8n` self-hosted, `PostgreSQL`, `Evolution API`, `ClickUp` y `Docker Compose`.

## Estado actual

El proyecto ya tiene una validacion funcional real de punta a punta con WhatsApp, `Evolution API`, `n8n`, `PostgreSQL`, round robin y ClickUp.

Estado implementado:

- se definio la estructura de carpetas del proyecto
- se dejaron archivos base versionables
- se dejo `Docker Compose` operativo para `n8n`, `PostgreSQL`, `Redis` y `Evolution API`
- se implemento la base de datos inicial del CRM
- se separo la base interna de `n8n` de la base del CRM
- se implementaron workflows base con logica real del CRM
- se sincronizaron workflows versionados en `n8n`
- se conecto y valido WhatsApp real con `Evolution API`
- se valido ClickUp con tareas reales de prueba
- se corrigieron loops conversacionales detectados durante validacion real
- se agrego y activo proteccion local del webhook con `EVOLUTION_WEBHOOK_SECRET`
- se agrego backup local inicial de PostgreSQL y volumen `n8n_data`
- se agrego `AI - Lead Qualification Assistant` como sub-workflow independiente y desactivado por defecto

Pendiente inmediato:

- validar `AI - Lead Qualification Assistant` con NVIDIA NIM u otro proveedor compatible con OpenAI y luego conectarlo al orquestador

## Objetivo del proyecto

Construir una automatizacion mantenible para:

- recibir mensajes entrantes desde WhatsApp via `Evolution API`
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
- [Evolution API](./docs/evolution-api.md)
- [Configuracion ClickUp](./docs/clickup-configuracion.md)
- [Matriz de pruebas conversacionales](./docs/matriz-pruebas-conversacionales.md)
- [Handoff Actual](./docs/handoff-actual.md)
- [Bitacora Validacion AI](./docs/bitacora-validacion-ai.md)
- [Operacion local](./docs/operacion-local.md)

## Archivos clave

- `docker-compose.yml`: punto de entrada de la orquestacion local
- `.env.example`: plantilla de variables de entorno
- `n8n/workflows/`: workflows exportados y versionados
- `n8n/workflow-links.json`: manifest de enlaces entre workflows por nombre
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
- `Evolution API`: `127.0.0.1:8080`

Bases de datos locales:

- `crm_whatsapp`: base interna de `n8n`
- `crm_whatsapp_app`: base del CRM y la logica de negocio
- `evolution_api`: base tecnica de `Evolution API`

## Siguiente paso sugerido

La matriz conversacional corta ya quedo versionada y cerrada en [`docs/matriz-pruebas-conversacionales.md`](./docs/matriz-pruebas-conversacionales.md). El siguiente paso recomendado es completar seguridad y recuperacion minima:

- proteccion del webhook de `WA - Inbound Entry`
- backup de PostgreSQL
- backup del volumen de `n8n`
- prueba controlada de `OPS - Error Handler`

El proyecto ya incluye un primer script local de backup:

```bash
sh scripts/ops/backup-local.sh
```

Para resincronizar workflows versionados cuando corresponda:

```bash
sh scripts/dev/sync-n8n-workflows.sh --preflight
sh scripts/dev/sync-n8n-workflows.sh
```

El script usa el CLI oficial de `n8n` para importar workflows, resuelve los sub-workflows por nombre desde `n8n/workflow-links.json` y conecta `OPS - Error Handler` como workflow de errores.
