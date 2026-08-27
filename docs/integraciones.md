# Integraciones

## Objetivo

Consolidar el inventario de integraciones externas y sus credenciales requeridas.

## Integraciones implementadas y previstas

### Evolution API

- recepcion de mensajes entrantes por webhook
- envio de respuestas automaticas
- gestion de instancias por numero
- soporte futuro para multiples numeros
- instancia default versionada `wahormiglass`, reconectada y validada en estado `open`
- descarga durable de media mediante `OPS - Media Download Scheduler` y el endpoint interno fijo `getBase64FromMediaMessage`
- `external_url` se conserva únicamente como metadata y nunca se usa como destino HTTP
- los bytes se validan antes de decodificar, se verifican por tipo, tamaño y SHA-256, y se escriben atómicamente en `/data/media/media/<prefijo>/<sha256>`
- la cola usa claim concurrente, recuperación de claims vencidos y backoff; errores de credenciales/configuración no consumen intentos
- el adjunto del binario a ClickUp continúa pendiente y ningún workflow invoca `mark_media_attached`

### ClickUp API

- creacion de tareas para leads
- asignacion inicial
- almacenamiento del historial conversacional y campos estructurados
- comentario adicional con la conversacion completa del cliente
- carga futura de adjuntos en la tarea
- uso de `field_id` y `option_id` reales para custom fields
- integracion validada con tareas reales de prueba

### Notificacion interna

- canal prioritario: ClickUp
- comentario asignado al vendedor en la tarea del lead
- los handoffs operativos crean una tarea dedicada mediante `OPS - Handoff Notification Scheduler`
- la asignacion por area se configura con `HANDOFF_CLICKUP_ASSIGNEES_JSON`; si falta token, lista o area, el envio falla cerrado
- `external_operations` reclama cada handoff una sola vez; `425/429` admiten backoff y un resultado ambiguo (`timeout`, `408`, `5xx`) exige reconciliacion manual sin reintento automatico
- auditoria e incidente operativo si la notificacion falla
- reintentos con backoff para errores de red y estados reintentables

### Seguimiento automático

- `OPS - Follow-Up Scheduler` ejecuta la cadencia 1/3/7/14 mediante `WA - Outbound Messages`
- cada turno inbound cancela la cadencia anterior y, si el bot queda esperando respuesta, abre un ciclo nuevo idempotente
- `FOLLOW_UP_WINDOW_START` y `FOLLOW_UP_WINDOW_END` restringen los envíos; los claims vencidos y errores confirmados se recuperan con backoff
- un resultado outbound ambiguo queda en cuarentena y nunca se reenvía automáticamente
- el opt-out se persiste en `follow_up_preferences` aunque todavía no existan filas en `follow_ups`, y bloquea ciclos futuros

### AI API directa

- integracion AI oficial mediante llamada directa desde `n8n`
- usa el rol conversacional `Hormi Atencion`
- usa Google Gemini mediante endpoint OpenAI-compatible
- modelo canonico: `gemini-3.1-flash-lite`
- devuelve JSON estructurado con memoria, actualizaciones, respuesta, siguiente accion y decision de lead
- no requiere procesos locales adicionales para la capa AI
- estado actual: conectado y validado con proveedor real
- endpoint versionado actual: `AI_DIRECT_API_PATH=/chat/completions`; el workflow tambien soporta `/responses`
- guia vigente: [`docs/ai-api-directa-configuracion.md`](./ai-api-directa-configuracion.md)

## Placeholders definidos

Los secretos reales no se guardan en el repositorio. Solo se dejan placeholders en `.env.example`.

## Estado actual de integraciones

Las integraciones principales ya quedaron conectadas y validadas en entorno local:

- `Evolution API` recibe mensajes de WhatsApp real y entrega eventos a `n8n`
- `n8n` procesa la conversacion, persiste estado y coordina sub-workflows
- `PostgreSQL` conserva leads, conversaciones, mensajes, asignaciones y auditoria
- ClickUp recibe leads confirmados, comentario conversacional completo y notificacion al vendedor
- Hormi Atencion por Gemini es la ruta AI oficial del proyecto

## Pendientes

- decidir estrategia operativa para multiples instancias
- incorporar agenda y stock solo cuando exista una fuente verificable
