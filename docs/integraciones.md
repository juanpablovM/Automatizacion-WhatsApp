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
- auditoria e incidente operativo si la notificacion falla
- reintentos con backoff para errores de red y estados reintentables

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
