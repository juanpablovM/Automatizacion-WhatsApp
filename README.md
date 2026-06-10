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
- se dejo `AI - Lead Qualification Assistant` como capa autonoma controlada para Hormi Atencion
- se preparo proveedor de API directa con salida JSON estructurada, sin depender de OpenClaw en la ruta por defecto
- `AI_LEAD_ASSISTANT_ENABLED=true` y `AI_PROVIDER=direct_api` quedan como valores versionados por defecto
- mientras no exista `AI_DIRECT_API_KEY` y `AI_DIRECT_API_MODEL`, la IA se omite de forma segura y el flujo cae a logica deterministica
- se definio la politica actual: Hormi Atencion tiene autonomia conversacional para extraer, responder y habilitar la creacion de lead cuando exista confirmacion; `n8n`/PostgreSQL ejecutan persistencia, ClickUp y asignacion
- los secretos reales quedan fuera de Git; `.env.example` solo contiene placeholders seguros

Pendiente inmediato:

- sincronizar workflows en la instancia viva y verificar que `WA - Inbound Entry` quede activo
- definir proveedor/modelo de API directa y cargar `AI_DIRECT_API_KEY` en `.env`
- ejecutar baseline deterministico con AI apagada solo como regresion comparativa
- validar matriz conversacional con Hormi Atencion encendida antes de considerar produccion

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
- [Runbook operativo](./docs/runbook-operacion.md)
- [AI API Directa](./docs/ai-api-directa-configuracion.md)
- [OpenClaw Configuracion](./docs/openclaw-configuracion.md)
- [Guia de produccion](./docs/guia-produccion.md)

## Estado real actual

Estado confirmado sobre el entorno local actual:

- sesion de WhatsApp `wahormiglass` reconectada y operativa
- `WA - Inbound Entry` activo en `n8n`
- webhook actual persistido hacia el workflow correcto
- prueba real de conversacion completada de punta a punta
- respuestas salientes confirmadas con estado `sent`
- derivacion comercial y `clickup_task_sync` vistos en auditoria real

Pendientes conocidos que aun no deben confundirse con una caida del flujo principal:

- existen logs historicos de webhooks viejos que ya no son configuracion activa
- el smoke de `OPS - Error Handler` todavia necesita cierre fino
- sigue faltando el checklist formal de salida a produccion

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

## Operacion y recuperacion

La matriz conversacional corta ya quedo versionada en [`docs/matriz-pruebas-conversacionales.md`](./docs/matriz-pruebas-conversacionales.md). La operacion diaria y recuperacion minima quedan consolidadas en [`docs/runbook-operacion.md`](./docs/runbook-operacion.md).

Orden operativo recomendado:

1. correr preflight de workflows y prueba local del asistente AI con mocks
2. sincronizar workflows versionados
3. validar healthcheck de `n8n`
4. correr backup y verify restore no destructivo
5. validar `OPS - Error Handler` con fallo controlado
6. ejecutar matriz conversacional con `AI_LEAD_ASSISTANT_ENABLED=false`
7. cargar `AI_DIRECT_API_KEY` y `AI_DIRECT_API_MODEL` solo cuando exista proveedor elegido
8. verificar que ningun lead se cree sin `servicio + ciudad + requerimiento + confirmacion`

Scripts operativos relevantes:

```bash
sh scripts/ops/backup-local.sh
sh scripts/ops/verify-backup-local.sh
sh scripts/ops/test-error-handler.sh
sh scripts/ops/test-ai-assistant-local.sh
sh scripts/dev/sync-n8n-workflows.sh --preflight
sh scripts/dev/sync-n8n-workflows.sh
```

El script usa el CLI oficial de `n8n` para importar workflows, resuelve los sub-workflows por nombre desde `n8n/workflow-links.json` y conecta `OPS - Error Handler` como workflow de errores.

La hoja de ruta de salida a produccion del proyecto quedo consolidada en [`docs/guia-produccion.md`](./docs/guia-produccion.md).

La carpeta `.hermes` fue retirada del workspace porque contenia un plan multiagente historico y parcialmente desactualizado. La fuente vigente para estado, handoff y pendientes del proyecto queda en `README.md` y `docs/`.
