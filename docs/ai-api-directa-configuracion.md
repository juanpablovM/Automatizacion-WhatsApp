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

La AI queda siempre habilitada en el proyecto. Si faltan credenciales o modelo real, el workflow registra `missing_api_config` y cae a fallback seguro, pero eso debe tratarse como una misconfiguracion bloqueante del entorno.

```bash
AI_PROVIDER=direct_api
AI_API_KEY_REQUIRED=true
AI_DIRECT_API_BASE_URL=https://api.openai.com/v1
AI_DIRECT_API_PATH=/chat/completions
AI_DIRECT_API_KEY=__PENDIENTE__
AI_DIRECT_API_MODEL=__PENDIENTE__
AI_DIRECT_API_TIMEOUT_MS=30000
AI_DIRECT_API_TEMPERATURE=0.05
AI_DIRECT_API_MAX_TOKENS=700
```

El workflow soporta dos formas de API directa:

- `/chat/completions`, valor versionado en `.env.example`
- `/responses`, disponible si el proveedor elegido lo requiere

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

El workflow acepta respuestas desde `choices[].message.content`, `output_text`, `reply`, `payloads[].text` o texto final compatible.

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

La prueba valida el contrato y el fallback con respuestas simuladas en memoria. No levanta servidores mock ni llama ninguna API externa.
