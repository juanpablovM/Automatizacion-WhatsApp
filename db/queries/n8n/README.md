# Queries n8n

## Objetivo

Versionar las queries SQL principales que usaran los workflows de `n8n` contra la base `crm_whatsapp_app`.

## Alcance

Estas queries sirven como plantillas operativas para los nodos `Postgres` de `n8n`.

No se ejecutan directamente desde el repo sin adaptar variables, porque usan placeholders logicos.

## Convencion de placeholders

Las queries usan placeholders como:

- `:phone_number`
- `:conversation_id`
- `:lead_id`

Estos valores deben ser reemplazados o mapeados desde `n8n` en la fase de implementacion de los nodos.

## Carpetas

- `wa-conversation-orchestrator/`
- `wa-outbound-messages/`
- `crm-lead-creation-and-assignment/`
- `crm-clickup-sync-lead/`
- `crm-seller-notification-dispatch/`
- `ops-error-handler/`

## Base objetivo

Las queries del CRM deben apuntar a:

- base: `crm_whatsapp_app`
- schema: `public`

## Nota

Las queries privilegian claridad y versionado sobre microoptimizacion prematura.

