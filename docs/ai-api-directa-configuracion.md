# AI API Directa Configuracion

## Decision vigente

La ruta AI oficial usa API directa desde `AI - Lead Qualification Assistant`.

Hormi Atencion se mantiene como rol conversacional autonomo:

- entiende intencion y contexto del cliente
- extrae `servicio`, `ciudad` y `requerimiento`
- redacta `reply_text`
- pide confirmacion cuando los datos estan completos
- marca `should_create_lead=true` solo con confirmacion explicita

La autonomia operativa sigue en `n8n`:

- la AI no escribe directamente en PostgreSQL
- la AI no crea tareas ClickUp fuera del workflow
- la AI no asigna vendedores fuera del round robin
- `n8n` valida schema, confianza, campos completos y confirmacion antes de ejecutar acciones

## Variables

Mientras no exista API key/modelo real, estos placeholders hacen que el workflow omita IA y use fallback deterministico.

```bash
AI_LEAD_ASSISTANT_ENABLED=true
AI_PROVIDER=direct_api
AI_API_KEY_REQUIRED=true
AI_DIRECT_API_BASE_URL=https://api.openai.com/v1
AI_DIRECT_API_PATH=/responses
AI_DIRECT_API_KEY=__PENDIENTE__
AI_DIRECT_API_MODEL=__PENDIENTE__
AI_DIRECT_API_TIMEOUT_MS=8000
AI_DIRECT_API_TEMPERATURE=0.2
```

Para activar con proveedor real:

```bash
AI_DIRECT_API_KEY=<redacted>
AI_DIRECT_API_MODEL=<modelo elegido>
docker compose --env-file .env up -d n8n
```

## Contrato JSON

La API debe devolver un objeto JSON compatible con:

- `intent`
- `lead_quality`
- `service`
- `city`
- `requirement`
- `missing_fields`
- `confirmation_status`
- `should_create_lead`
- `needs_confirmation`
- `confidence`
- `reply_text`
- `clickup_summary`

El workflow acepta respuestas desde `output_text`, `choices[].message.content`, `reply`, `payloads[].text` o texto final compatible.

## Guardrails

- `confidence < 0.75`: no se aceptan campos nuevos.
- JSON invalido: fallback deterministico.
- error HTTP o timeout: fallback deterministico.
- `should_create_lead=true` solo se respeta con `servicio + ciudad + requerimiento + confirmation_status=confirmed + intent=confirmation_yes`.
- `clickup_summary` solo se expone cuando el lead queda confirmado.

## Prueba local sin proveedor real

```bash
sh scripts/ops/test-ai-assistant-local.sh
```

La prueba usa mocks y no llama ninguna API externa.
