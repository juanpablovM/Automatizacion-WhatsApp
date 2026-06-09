# Arquitectura

## Objetivo

Documentar la arquitectura tecnica del proyecto de automatizacion de leads por WhatsApp.

## Alcance de este documento

Este documento describira la arquitectura objetivo del sistema, incluyendo:

- componentes principales
- responsabilidades de `n8n`
- responsabilidades de `PostgreSQL`
- integraciones externas
- preparacion para escalado futuro

## Estado actual

La arquitectura local ya fue implementada y validada funcionalmente con mensajes reales de WhatsApp hasta creacion de tareas en ClickUp.

## Componentes implementados

- `n8n` como orquestador de workflows e integraciones
- `PostgreSQL` como persistencia y fuente de verdad del estado
- `Evolution API` como canal self-hosted de entrada y salida de WhatsApp
- `Redis` como dependencia operativa de `Evolution API`
- ClickUp como CRM operativo de leads
- ClickUp como canal interno inicial de notificacion al vendedor
- OpenClaw local como proveedor AI oficial mediante bridge HTTP y agente `hormi-atencion` (`Hormi Atencion`)

## Topologia local actual

```mermaid
flowchart LR
    User["Tu Mac"] --> Browser["Navegador<br/>127.0.0.1:5678"]
    Browser --> N8N["Contenedor n8n"]
    N8N --> PG["Contenedor PostgreSQL"]
    N8N --> EVO["Contenedor Evolution API"]
    EVO --> REDIS["Contenedor Redis"]
    EVO --> PG
    N8N --> CU["ClickUp API"]
    N8N -.->|AI oficial<br/>Hormi Atencion| OC["OpenClaw local<br/>Bridge HTTP"]
    WA["WhatsApp real"] --> EVO
    EVO --> N8N
```

## Decisiones tecnicas implementadas en esta fase

- `n8n` y `PostgreSQL` corren en contenedores Docker, sin instalacion nativa en macOS.
- `Evolution API` y `Redis` se agregan como servicios locales del stack.
- ambos servicios publican puertos solo en `127.0.0.1`
- la persistencia usa volumenes nombrados de Docker
- `PostgreSQL` expone `5433` localmente para facilitar inspeccion futura
- `n8n` usa `PostgreSQL` como base principal desde el inicio
- `Evolution API` usa una base separada dentro del mismo servidor PostgreSQL
- `infra/postgres/init/` queda montado para scripts iniciales si luego se usan
- el webhook actual funciona localmente desde `Evolution API` hacia `n8n` usando `host.docker.internal`
- ClickUp ya fue integrado con creacion de tareas, comentario conversacional completo y notificacion inicial al vendedor
- la capa AI oficial es Hormi Atencion en OpenClaw: puede extraer datos, responder, pedir confirmacion y habilitar la creacion de lead cuando el usuario confirma
- `n8n` y PostgreSQL conservan la ejecucion del estado: la AI no escribe directo en PostgreSQL, no crea tareas ClickUp por fuera del workflow y no asigna vendedores por fuera del round robin
- los secretos reales de OpenClaw, ClickUp y Evolution quedan fuera de Git; solo el integrador debe usarlos para pruebas reales
- la configuracion operativa de OpenClaw vive en `docs/openclaw-configuracion.md`
- la exposicion publica de webhooks no se implementa todavia; el entorno actual sigue pensado para operacion local controlada

## Autenticacion de n8n

En versiones actuales de `n8n`, el acceso inicial queda protegido por el flujo de creacion del usuario propietario en el primer arranque. En esta base local no se implementa autenticacion basica antigua.

## Pendientes

- validar matriz conversacional completa con AI apagada y AI encendida
- validar Hormi Atencion con servicios vivos desde el workspace del integrador
- ejecutar pruebas controladas con `AI_PROVIDER=openclaw` y `OPENCLAW_AGENT=hormi-atencion`
- validar restore completo en entorno aislado si se requiere recuperacion total
- documentar estrategia operativa de multiples instancias en `Evolution API`
