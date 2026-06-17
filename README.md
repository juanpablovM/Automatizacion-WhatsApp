# CRM WhatsApp Automatizado

Automatizacion para capturar, calificar, registrar y asignar leads desde WhatsApp usando `n8n`, `PostgreSQL`, `Evolution API`, `ClickUp` y `Docker Compose`.

## Que hace este proyecto

Este repo implementa una base operativa para:

- recibir mensajes entrantes desde WhatsApp via `Evolution API`
- guiar la conversacion para capturar servicio, ciudad y requerimiento
- crear y trazar leads en `PostgreSQL`
- asignar leads con round robin
- sincronizar leads a `ClickUp`
- notificar al vendedor asignado
- dejar auditoria tecnica y funcional del flujo

Tambien prepara una evolucion controlada hacia un asesor comercial AI, manteniendo a `n8n` y `PostgreSQL` como capa de control del estado y de las integraciones.

## Arquitectura

Componentes principales:

- `n8n`: orquestacion de workflows e integraciones
- `PostgreSQL`: fuente de verdad del CRM, conversaciones, mensajes, auditoria y asignaciones
- `Evolution API`: entrada y salida de WhatsApp self-hosted
- `Redis`: soporte operativo de `Evolution API`
- `ClickUp`: destino operativo de los leads
- proveedor AI por API directa: capa opcional para comprension y respuesta conversacional

Principio clave:

- la AI puede interpretar, responder y sugerir decisiones conversacionales
- `n8n` valida y ejecuta persistencia, asignacion, ClickUp y auditoria
- la AI no escribe directamente en la base ni opera ClickUp por fuera del workflow

## Estado del proyecto

Estado actual de madurez:

- base tecnica implementada y documentada
- workflows principales versionados
- integracion con WhatsApp, `PostgreSQL` y `ClickUp` ya incorporada al flujo
- asistente AI preparado con fallback seguro a flujo deterministico
- esquema de base ampliado para soportar catalogo, precios, condiciones y futura evolucion comercial AI

Estado recomendado para comunicar publicamente:

- `preproduccion / validacion controlada`

Eso significa que el proyecto ya tiene implementacion real y documentacion amplia, pero todavia requiere endurecimiento operativo, validacion ampliada y cierre formal antes de considerarse listo para produccion.

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
- auditoria de decisiones AI en `advisor_decisions` desde el orquestador conversacional
- PRD funcional del agente Hormiglass con diagnostico D.A.T.O.S., clasificacion A/B/C/D y guardrails comerciales

No cubre todavia de punta a punta:

- salida productiva endurecida
- staging separado
- agenda real
- condiciones comerciales aprobadas
- FAQ y objeciones cargadas como fuente oficial
- conversacion end-to-end con AI encendida y proveedor/mock registrando decisiones reales
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
- `CLICKUP_LIST_ID`
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
sh scripts/dev/sync-n8n-workflows.sh
```

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

## Asistente AI

El subworkflow `AI - Lead Qualification Assistant` funciona como capa opcional de asistencia conversacional.

Comportamiento esperado:

- si la AI esta bien configurada, puede interpretar intencion, extraer datos y redactar respuesta
- si falta configuracion, hay error del proveedor o la confianza es insuficiente, el flujo debe caer a una ruta deterministica segura

El proyecto ya incluye:

- contrato estructurado de salida JSON
- pruebas locales con mocks
- base de contexto comercial para catalogo y precios publicos

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

- cerrar baseline deterministico sin AI
- ampliar validacion end-to-end
- endurecer configuracion para staging y produccion
- completar validaciones de salida operativa
- conectar fuentes oficiales adicionales para la fase de asesor comercial AI

## Licencia / uso

Si este repo va a hacerse publico de forma abierta, conviene agregar una licencia explicita y revisar que no queden artefactos historicos ni documentacion operativa sensible antes de exponerlo.
