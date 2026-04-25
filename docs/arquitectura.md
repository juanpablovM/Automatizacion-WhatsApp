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

Documento base creado en la FASE 2 y ampliado en la FASE 3 con la topologia local inicial.

## Componentes previstos

- `n8n` como orquestador de workflows e integraciones
- `PostgreSQL` como persistencia y fuente de verdad del estado
- `Evolution API` como canal self-hosted de entrada y salida de WhatsApp
- `Redis` como dependencia operativa de `Evolution API`
- ClickUp como CRM operativo de leads
- canal interno de notificacion al vendedor

## Topologia local inicial

```mermaid
flowchart LR
    User["Tu Mac"] --> Browser["Navegador<br/>127.0.0.1:5678"]
    Browser --> N8N["Contenedor n8n"]
    N8N --> PG["Contenedor PostgreSQL"]
    N8N --> EVO["Contenedor Evolution API"]
    EVO --> REDIS["Contenedor Redis"]
    EVO --> PG
    N8N -. futuro .-> CU["ClickUp API"]
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
- la exposicion publica de webhooks no se implementa todavia; solo queda preparada por variables

## Autenticacion de n8n

En versiones actuales de `n8n`, el acceso inicial queda protegido por el flujo de creacion del usuario propietario en el primer arranque. En esta base local no se implementa autenticacion basica antigua.

## Pendientes

- definir exposicion futura de webhooks
- documentar separacion exacta entre logica en `n8n` y logica en `PostgreSQL`
- documentar estrategia operativa de multiples instancias en `Evolution API`
