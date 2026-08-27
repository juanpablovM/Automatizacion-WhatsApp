# AI API Directa Configuracion

## Decision vigente

La ruta AI oficial usa API directa desde `AI - Lead Qualification Assistant`.

Hormi Atencion se mantiene como rol conversacional autonomo:

- entiende intencion y contexto del cliente
- mantiene diagnostico comercial, memoria y pregunta pendiente
- extrae y actualiza los datos relevantes de cada intencion
- redacta `reply_text`
- pide confirmacion cuando los datos estan completos
- marca `should_create_lead=true` solo con confirmacion explicita

La autonomia operativa sigue en `n8n`:

- la AI no escribe directamente en PostgreSQL
- la AI no crea tareas ClickUp fuera del workflow
- la AI no asigna vendedores fuera del round robin
- `n8n` valida schema, confianza, campos completos y confirmacion antes de ejecutar acciones

## Variables

`AI_PROVIDER` es una etiqueta operativa para auditoria y compatibilidad.
El comportamiento real del proveedor lo determinan:

- `AI_DIRECT_API_BASE_URL`
- `AI_DIRECT_API_PATH`
- `AI_DIRECT_API_MODEL`

La configuracion versionada vigente usa un endpoint OpenAI-compatible de Google.
Si cambias de proveedor, alinea `.env`, `.env.example` y `docker-compose.yml`.
El modelo canónico actual es `gemini-3.1-flash-lite`.
`gemini-3.5-flash` queda reservado como alternativa de escalamiento o canary si la calidad conversacional no basta.
No versionar `preview` ni aliases `latest` como default del proyecto.

La AI queda siempre habilitada en el proyecto. Si faltan credenciales o modelo real, el workflow registra `missing_api_config` y cae a fallback seguro, pero eso debe tratarse como una misconfiguracion bloqueante del entorno.

```bash
AI_LEAD_ASSISTANT_ENABLED=true
AI_PROVIDER=google
AI_API_KEY_REQUIRED=true
AI_DIRECT_API_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai
AI_DIRECT_API_PATH=/chat/completions
AI_DIRECT_API_KEY=__PENDIENTE__
AI_DIRECT_API_MODEL=gemini-3.1-flash-lite
AI_DIRECT_API_TIMEOUT_MS=120000
AI_DIRECT_API_TEMPERATURE=0.1
AI_DIRECT_API_MAX_TOKENS=2000
AI_DIRECT_API_MAX_ATTEMPTS=2
AI_DIRECT_API_RETRY_BASE_MS=2000
AI_DIRECT_API_RETRY_MAX_MS=30000
AI_DIRECT_API_RATE_LIMIT_COOLDOWN_MS=60000
AI_MODEL_C_ENABLED=true
AI_HEALTHY_MIN_CONFIDENCE=0.45
AI_FIELD_ACCEPT_MIN_CONFIDENCE=0.55
AI_REPLY_TEXT_MIN_CONFIDENCE=0.50
AI_OBJECTION_MIN_CONFIDENCE=0.50
AI_B2B_MIN_CONFIDENCE=0.55
AI_PRD_VALIDATION_ENABLED=true
```

El workflow soporta dos formas de API directa:

- `/chat/completions`, valor versionado en `.env.example`
- `/responses`, disponible si el proveedor elegido lo requiere

Para activar con proveedor real:

```bash
AI_DIRECT_API_KEY=<redacted>
AI_DIRECT_API_MODEL=gemini-3.1-flash-lite
docker compose --env-file .env up -d n8n
```

Si mas adelante se prueba `gemini-3.5-flash`, hacerlo como cambio controlado de entorno y volver a correr el contrato local y la matriz conversacional antes de dejarlo fijo.

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
- `field_updates`
- `answered_question_key`
- `next_question_key`
- `advisor_reasoning_summary`
- `next_best_action`

El workflow acepta respuestas desde `choices[].message.content`, `output_text`, `reply`, `payloads[].text` o texto final compatible.

## Guardrails

- `confidence < 0.75`: no se aceptan campos nuevos.
- JSON invalido: fallback deterministico.
- error HTTP o timeout: fallback deterministico.
- `HTTP 429`: se respeta `Retry-After`, se limitan los reintentos y se abre un cooldown para no agravar el limite del proveedor.
- El contexto comercial se compacta antes de enviarlo y el JSON Schema no se duplica en `/chat/completions`.
- Los campos mencionados explicitamente pueden reemplazar estado obsoleto en correcciones o solicitudes nuevas.
- `should_create_lead=true` solo se respeta con datos criticos, confirmacion aplicable y confianza suficiente.
- `clickup_summary` solo se expone cuando el lead queda confirmado.
- las actualizaciones se contrastan con `qualification_context` y `pending_question_key`.
- una respuesta nunca puede anunciar derivacion si aun no existe `lead_id`.

La auditoria AI conserva `status_code`, cantidad de intentos, `retry_after_ms`, estado del circuito y tamano del request. Un workflow puede finalizar correctamente y aun registrar `rate_limited`; en ese caso la respuesta visible proviene del fallback seguro.

## Prueba local sin proveedor real

```bash
sh scripts/ops/test-ai-assistant-local.sh
```

La prueba valida el contrato y el fallback con respuestas simuladas en memoria. No levanta servidores mock ni llama ninguna API externa.
