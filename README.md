# CRM WhatsApp Automatizado

Automatizacion para capturar, calificar, registrar y asignar leads desde WhatsApp usando `n8n`, `PostgreSQL`, `Evolution API`, `ClickUp` y `Docker Compose`.

## Que hace este proyecto

Este repo implementa un asesor comercial operativo para:

- recibir mensajes entrantes desde WhatsApp via `Evolution API`
- conversar como asesor comercial segun el PRD Hormiglass
- diagnosticar mediante D.A.T.O.S. y capturar contexto tecnico/comercial
- interpretar respuestas breves segun la pregunta pendiente
- crear y trazar leads en `PostgreSQL`
- asignar leads con round robin
- sincronizar leads a `ClickUp`
- notificar al vendedor asignado
- dejar auditoria tecnica, funcional y de decisiones AI
- confirmar la derivacion solo despues de crear y asignar el lead

## Arquitectura

Componentes principales:

- `n8n`: orquestacion de workflows e integraciones
- `PostgreSQL`: fuente de verdad del CRM, conversaciones, mensajes, auditoria y asignaciones
- `Evolution API`: entrada y salida de WhatsApp self-hosted
- `Redis`: soporte operativo de `Evolution API`
- `ClickUp`: destino operativo de los leads
- proveedor AI por API directa: capa oficial para comprension y respuesta conversacional

Principio clave:

- la AI puede interpretar, responder y sugerir decisiones conversacionales
- `n8n` valida y ejecuta persistencia, asignacion, ClickUp y auditoria
- la AI no escribe directamente en la base ni opera ClickUp por fuera del workflow

## Estado del proyecto

Estado recomendado: `preproduccion / validacion controlada`.

> Todo el tráfico del sistema es de prueba. No hay clientes reales: las conversaciones se conducen deliberadamente para encontrar fallas del bot.

- Repositorio y runtime están alineados. `main` quedó reconciliada el 2026-08-27 tras 87 commits represados, y está protegida con los cinco checks de `Delivery Validation` como requeridos.
- La entrega a ClickUp ya no está limitada a Sales por código: **la configuración decide** qué áreas son entregables, según los asignados declarados en `HANDOFF_CLICKUP_ASSIGNEES_JSON`. El marcador exacto `Operation key: {operation_key}` y la reconciliación GET-first antes de cualquier POST ambiguo siguen vigentes.
- Un despacho diferido tiene ventana de seis horas. Pasada, termina de forma visible en vez de reintentar cada 60 segundos indefinidamente.
- El grafo de conexiones de los workflows está bajo gate: terminales esperadas, ambas ramas de cada IF cableadas, y referencias solo a nodos existentes.
- Los 7 salientes históricos en `unknown` y las operaciones 89 y 90 con marcador `preserved_test_artifact_closed_no_replay` se conservan como evidencia. **No deben reejecutarse (`replay`) ni reintentarse.**
- Queda pendiente configurar el asignado de ClickUp para `b2b`: el área está declarada con cero asignados, así que un handoff B2B difiere y termina visible en lugar de entregarse.
- El contrato conversacional v3 está congelado: implementado y verificado, pero su carril no está conectado a la salida.
- U4, U7, U8 y U9 permanecen pendientes por decisión. La certificación vigente no demuestra todavía el cierre del PRD.

El corte canónico y la separación entre repositorio, runtime y certificación están en [`docs/estado-actual.md`](./docs/estado-actual.md).

## Alcance actual

Hoy el repo cubre:

- orquestacion de entrada WhatsApp
- gestion de conversaciones y mensajes
- creacion y asignacion de leads
- sincronizacion a `ClickUp`
- notificacion al vendedor
- auditoria de errores y eventos
- contratos y pruebas locales del asistente AI
- base de catalogo y precios publicos para evolucion comercial AI
- memoria comercial estructurada en conversaciones y leads
- preguntas consultivas de un dato principal por turno
- interpretacion contextual de `si/no`
- resumen ejecutivo enriquecido para ClickUp
- auditoria de decisiones AI en `advisor_decisions` desde el orquestador conversacional
- PRD funcional del agente Hormiglass con diagnostico D.A.T.O.S., clasificacion A/B/C/D y guardrails comerciales

Pendientes fuera del alcance actual:

- salida productiva endurecida
- staging separado
- agenda real con cupos reservables
- integracion de inventario para confirmar stock
- validacion financiera automatica de pagos
- observabilidad y monitoreo de nivel produccion

La configuracion funcional vigente del asesor esta en `docs/prd-agente-whatsapp-hormiglass.md`.

## Estructura del repositorio

```text
docs/                Documentacion funcional, tecnica y operativa
infra/               Infraestructura base y migraciones de arranque
n8n/                 Workflows versionados y samples
db/                  Esquema, seeds y queries SQL
scripts/             Utilidades de desarrollo, operacion y pruebas
docker-compose.yml   Orquestacion local del stack
```

## Inicio rapido local

### Requisitos

- Docker y Docker Compose
- puertos locales disponibles para `n8n`, `PostgreSQL` y `Evolution API`

### 1. Crear configuracion local

```bash
cp .env.example .env
```

### 2. Ajustar valores minimos en `.env`

Antes de levantar el stack, reemplaza al menos:

- `POSTGRES_PASSWORD`
- `N8N_ENCRYPTION_KEY`
- `EVOLUTION_API_KEY`
- `EVOLUTION_WEBHOOK_SECRET`

Si vas a probar integraciones reales, tambien completa:

- `CLICKUP_API_TOKEN`
- `CLICKUP_LEADS_LIST_ID` para las tareas creadas por el flujo comercial
- `CLICKUP_HANDOFF_LIST_ID` para las notificaciones operativas de handoff
- `CLICKUP_CF_*`
- `AI_DIRECT_API_KEY`
- `AI_DIRECT_API_MODEL`

### 3. Levantar el entorno

```bash
docker compose --env-file .env up -d
```

### 4. Abrir `n8n`

```text
http://127.0.0.1:5678
```

En el primer arranque, `n8n` pedira crear el usuario propietario de la instancia.

### 5. Sincronizar workflows versionados

```bash
sh scripts/dev/sync-n8n-workflows.sh --preflight
E2E_ALLOW_EXTERNAL_EFFECTS=yes sh scripts/dev/sync-n8n-workflows.sh --deploy TELEFONO_CONTROLADO
```

La sincronizacion es un release gate: captura un snapshot, pausa Entry/Recovery,
resuelve todos los enlaces por nombre, importa, exporta y verifica el runtime, y
solo entonces reactiva el trafico. Comandos operativos:

```bash
sh scripts/dev/sync-n8n-workflows.sh --verify-remote
sh scripts/dev/sync-n8n-workflows.sh --snapshot /ruta/snapshot
sh scripts/dev/sync-n8n-workflows.sh --rollback /ruta/snapshot
sh scripts/ops/test-dispatcher-runtime-integrity-local.sh all
E2E_ALLOW_EXTERNAL_EFFECTS=yes sh scripts/ops/test-e2e-lead-creation.sh TELEFONO_CONTROLADO
```

`--rollback` pausa antes de importar, restaura y verifica el snapshot completo.
`--deploy` aísla Evolution durante la aceptación, exige teléfono controlado y
opt-in, y activa definitivamente solo después del E2E y replay idempotente.

## Servicios locales

- `n8n`: `http://127.0.0.1:5678`
- `PostgreSQL`: `127.0.0.1:5433`
- `Evolution API`: `http://127.0.0.1:8080`

Nota de seguridad:

el `docker-compose.yml` actual publica puertos para facilitar operacion local. Antes de staging o produccion, esa exposicion debe restringirse con red privada, firewall, proxy y HTTPS.

## Workflows principales

Workflows versionados en `n8n/workflows/`:

- `WA - Inbound Entry`
- `WA - Conversation Orchestrator`
- `WA - Outbound Messages`
- `CRM - Lead Creation And Assignment`
- `CRM - ClickUp Sync Lead`
- `CRM - Seller Notification Dispatch`
- `AI - Lead Qualification Assistant`
- `OPS - Error Handler`

Los enlaces entre subworkflows se mantienen por nombre en `n8n/workflow-links.json`, y el script de sincronizacion resuelve los IDs reales en `n8n`.

## Base de datos

La persistencia queda separada en tres bases:

- `crm_whatsapp`: base interna de `n8n`
- `crm_whatsapp_app`: base del CRM y la logica de negocio
- `evolution_api`: base tecnica de `Evolution API`

El esquema principal incluye:

- leads
- conversaciones
- mensajes
- adjuntos
- vendedores
- asignaciones
- auditoria
- catalogos de estados
- tablas base para asesor comercial AI
- contexto de calificacion persistente y pregunta pendiente contextual

## Asistente AI

El subworkflow `AI - Lead Qualification Assistant` funciona como la capa oficial de asistencia conversacional.

Comportamiento esperado:

- Gemini es la voz principal: interpreta, orienta, maneja objeciones y redacta la respuesta
- `n8n` valida actualizaciones de campos, guardrails y siguiente accion
- cada turno hace una sola pregunta principal cuando se requieren datos
- respuestas `si/no` se interpretan segun `pending_question_key`
- el handoff se anuncia solo despues de crear y asignar el lead
- si falta configuracion, hay error del proveedor o la confianza es insuficiente, el flujo cae a una ruta deterministica segura sin apagar la AI del proyecto

El proyecto ya incluye:

- contrato estructurado de salida JSON
- pruebas locales de contrato y fallback con respuestas simuladas en memoria
- base de contexto comercial para catalogo, precios, condiciones, FAQ y objeciones
- prueba real reproducible `scripts/ops/test-advisor-vitacura-e2e.sh`

## Documentacion recomendada

Para entender el proyecto desde lo general a lo especifico:

- [Arquitectura](./docs/arquitectura.md)
- [Flujo de leads](./docs/flujo-leads.md)
- [Workflows n8n](./docs/n8n-workflows.md)
- [Base de datos](./docs/base-de-datos.md)
- [Integraciones](./docs/integraciones.md)
- [Evolution API](./docs/evolution-api.md)
- [Configuracion ClickUp](./docs/clickup-configuracion.md)
- [AI API directa](./docs/ai-api-directa-configuracion.md)
- [Asesor comercial AI](./docs/asesor-comercial-ai.md)
- [Fuentes comerciales AI](./docs/fuentes-comerciales-ai.md)
- [Guia de produccion](./docs/guia-produccion.md)
- [Estado actual 2026-08-08](./docs/estado-actual.md)

La documentacion operativa de mantenimiento diario, runbooks y handoff conviene tratarla como material interno del equipo si el repositorio va a mantenerse publico.

## Seguridad y datos sensibles

Este repositorio no debe versionar:

- secretos reales
- numeros de WhatsApp reales
- vendedores reales
- tokens de integracion
- seeds operativos privados
- backups

La plantilla `.env.example` contiene placeholders seguros. Toda configuracion real debe vivir fuera de Git.

## Roadmap tecnico inmediato

- endurecer configuracion para staging y produccion
- agregar monitoreo, alertas y correlacion operativa
- definir agenda real antes de ofrecer cupos
- integrar inventario y Finanzas solo cuando existan fuentes confiables
- ampliar la matriz E2E con B2B, reclamos, garantia y pagos

## Licencia / uso

Si este repo va a hacerse publico de forma abierta, conviene agregar una licencia explicita y revisar que no queden artefactos historicos ni documentacion operativa sensible antes de exponerlo.
