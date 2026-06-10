# Arquitectura n8n

## Objetivo

Documentar la arquitectura de workflows de `n8n` implementada para la automatizacion de leads por WhatsApp.

Este documento conserva la intencion de diseno original, pero el estado actual ya no es solo propuesto: los workflows principales existen, estan versionados en `n8n/workflows/`, fueron importados en `n8n` y se validaron con mensajes reales.

## Principios de diseno

- `n8n` actua como orquestador de eventos, integraciones y manejo operativo de errores
- `PostgreSQL` actua como fuente de verdad del estado conversacional y del dominio CRM
- la extraccion de datos usa enfoque hibrido:
  - primero logica deterministica
  - luego enriquecimiento opcional con IA si hace falta
- los workflows se separan por responsabilidad para que sean portables, mantenibles y reutilizables por cliente
- las integraciones externas se encapsulan para poder cambiar canales sin romper la logica central

## Estrategia general

La implementacion se divide en workflows pequenos y coordinados.

Se evita un workflow unico grande porque:

- dificulta mantenimiento
- mezcla persistencia con integraciones
- complica reintentos
- vuelve mas fragil la migracion a otros clientes

## Distribucion de responsabilidades

### En PostgreSQL

- estado de conversacion
- estado del lead
- deduplicacion por telefono
- recuperacion de conversacion activa
- round robin persistente
- historial de asignaciones
- auditoria
- metadata de mensajes y adjuntos

### En n8n

- recepcion del webhook
- validacion del payload entrante
- secuencia del flujo conversacional
- extraccion y normalizacion de datos
- llamadas a `Evolution API`
- llamadas a ClickUp
- notificacion interna
- reintentos operativos
- enrutamiento de errores

## Estrategia de extraccion de datos

### Capa 1: extraccion deterministica

Se usa primero una capa simple y explicable con `Code`:

- limpieza de texto
- deteccion de saludo vacio
- deteccion de respuestas utiles
- normalizacion basica de ciudad
- consolidacion de campos ya detectados

### Capa 2: Hormi Atencion en API directa

Queda implementada como sub-workflow independiente y apagable para regresiones:

- tomar un mensaje libre amplio del cliente
- proponer `service`, `city` y `requirement`
- devolver estructura JSON controlada
- responder de forma natural cuando el agente tiene confianza suficiente
- habilitar la creacion de lead solo cuando el usuario confirma y existen los datos minimos
- usar API directa con el agente `Hormi Atencion`

Regla:

- Hormi Atencion gobierna la conversacion asistida
- `n8n` y PostgreSQL siguen siendo la fuente de ejecucion para persistencia, ClickUp y asignacion

## Workflows implementados

### 1. `WA - Inbound Entry`

Responsabilidad:

- recibir eventos entrantes desde `Evolution API`
- normalizar el payload inicial
- enrutar eventos utiles al procesamiento conversacional
- responder rapido `accepted` al webhook
- encadenar orquestacion conversacional, respuesta saliente, creacion de lead, ClickUp y notificacion

Entrada:

- webhook HTTP desde `Evolution API`

Salida:

- payload canonico de mensaje entrante
- derivacion a workflow de procesamiento

Nodos principales:

- `Webhook`
- `Respond to Webhook`
- `Code`
- `Execute Workflow`

Notas:

- soporta mensajes utiles desde eventos `MESSAGES_UPSERT`
- ignora mensajes propios, grupos y eventos no procesables
- soporta validacion opcional por secreto compartido con `EVOLUTION_WEBHOOK_SECRET`; si la variable esta vacia, no bloquea eventos para no romper el entorno local existente
- antes de exposicion publica se debe configurar el secreto real en `.env`, persistir el webhook de Evolution con `?token=...` o header equivalente y probar rechazo de eventos sin secreto

### 2. `WA - Conversation Orchestrator`

Responsabilidad:

- leer el estado conversacional actual
- registrar mensaje y payload
- recuperar o crear conversacion
- decidir el siguiente paso
- persistir cambios del dominio
- decidir si continua preguntando o si pasa a creacion de lead

Entrada:

- payload canonico desde `WA - Inbound Entry`

Salida:

- mensaje de respuesta al cliente
- o senal de crear lead
- o senal de error

Nodos principales:

- `Postgres`
- `Code`
- `Merge`

Uso de `Code`:

- consolidacion de contexto conversacional
- deteccion de campos ya respondidos
- seleccion de pregunta pendiente
- conteo de intentos de comprension
- separacion entre intencion detectada y datos suficientes
- confirmacion de `servicio + ciudad + requerimiento concreto`

Uso de AI:

- subpaso oficial cuando el mensaje libre trae contexto suficiente o confirma datos
- resultado siempre validado antes de persistir
- se invoca solo si `AI_LEAD_ASSISTANT_ENABLED=true`
- con el flag apagado, el flujo debe comportarse igual que el flujo deterministico base para regresion
- puede habilitar creacion de lead solo con confirmacion explicita, campos completos y confianza suficiente
- no puede sobrescribir datos confirmados salvo correccion explicita del usuario

### 3. `AI - Lead Qualification Assistant`

Responsabilidad:

- llamar al proveedor AI directo configurado, por defecto `POST /responses`
- extraer intencion, calidad del lead, servicio, ciudad y requerimiento
- proponer texto de respuesta y resumen para ClickUp
- aplicar guardrails basicos antes de devolver `should_create_lead`

Entrada:

- mensaje actual
- estado conversacional actual
- ultimos mensajes relevantes
- campos ya detectados
- lead previo si existe

Salida:

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

Estado:

- activado en la plantilla mediante `AI_LEAD_ASSISTANT_ENABLED=true`
- proveedor versionado: `AI_PROVIDER=direct_api`
- requiere `AI_DIRECT_API_KEY` y `AI_DIRECT_API_MODEL` para llamar al proveedor real
- con placeholders pendientes, omite IA con `ai_skip_reason=missing_api_config` y mantiene fallback deterministico
- no escribe directo en PostgreSQL
- no crea tareas ClickUp fuera del workflow
- no asigna vendedores fuera del round robin
- usa `Authorization: Bearer $AI_DIRECT_API_KEY` para API directa
- parsea respuestas desde `output_text`, `choices[].message.content`, `reply`, `payloads[].text` o texto final compatible
- fuerza `should_create_lead=false` si falta confirmacion explicita
- descarta campos nuevos cuando `confidence < 0.75`; solo conserva campos existentes del contexto
- ante JSON invalido o error del proveedor, devuelve fallback seguro sin crear lead
- prueba local de contrato: `sh scripts/ops/test-ai-assistant-local.sh`
- solo el integrador debe cargar secretos reales y ejecutar pruebas contra el proveedor AI

### 4. `WA - Outbound Messages`

Responsabilidad:

- enviar mensajes salientes al cliente por `Evolution API`
- registrar intento de envio
- registrar auditoria y estado del envio

Entrada:

- payload de mensaje saliente estructurado

Salida:

- resultado del envio
- evento de error si no pudo enviarse

Nodos principales:

- `Code`
- `Postgres`
- `Merge`

Casos cubiertos:

- bienvenida
- pregunta pendiente
- reencauce
- derivacion final
- reintentos con backoff para estados reintentables de `Evolution API` y errores de red

### 5. `CRM - Lead Creation And Assignment`

Responsabilidad:

- crear el lead en `crm_whatsapp_app`
- recuperar o heredar datos previos si aplica
- ejecutar round robin
- persistir asignacion
- dejar el lead listo para ClickUp

Entrada:

- senal desde `conversation_orchestrator`

Salida:

- lead consolidado y vendedor asignado

Nodos principales:

- `Postgres`
- `Code`

Uso de SQL:

- lectura de lead previo
- escritura del lead
- actualizacion del puntero de round robin
- insercion en `lead_assignments`
- auditoria

### 6. `CRM - ClickUp Sync Lead`

Responsabilidad:

- construir el payload de ClickUp
- crear la tarea en `Leads Entrantes`
- asignar vendedor con `clickup_user_id`
- devolver siempre `lead_id`, `clickup_task_id` y `clickup_task_url` al workflow padre
- crear comentario con conversacion completa cuando hay historial disponible
- preparar carga de adjuntos
- registrar exito o error

Entrada:

- lead consolidado con asignacion

Salida:

- `clickup_task_id`
- `clickup_task_url`
- resultado de sincronizacion

Nodos principales:

- `HTTP Request`
- `Code`
- `Postgres`
- `Merge`

Notas:

- los custom fields se parametrizan por variables `CLICKUP_*`
- la salida final pasa por `Create Conversation Comment If Present`, que conserva el payload aunque el comentario se salte o falle
- la creacion de tarea y el comentario conversacional completo tienen reintentos con backoff para estados reintentables
- la creacion de tareas fue validada con ClickUp real

### 7. `CRM - Seller Notification Dispatch`

Responsabilidad:

- enviar la notificacion al vendedor
- dejar el canal desacoplado
- registrar incidente operativo si falla

Entrada:

- lead listo y tarea de ClickUp creada

Salida:

- confirmacion de notificacion
- o incidente operativo

Nodos principales:

- `Code`
- `Postgres`
- `Merge`

Diseño:

- subworkflow abstracto
- canal primario: ClickUp
- comenta la tarea creada y asigna el comentario al `clickup_user_id`
- requiere que el lead tenga vendedor con `clickup_user_id`
- mas adelante puede admitir otro canal sin cambiar el resto
- usa reintentos con backoff para estados reintentables de ClickUp y errores de red

### 8. `OPS - Error Handler`

Responsabilidad:

- centralizar errores funcionales y tecnicos
- escribir auditoria
- marcar incidente operativo cuando corresponda
- decidir si amerita reintento o escalamiento

Entrada:

- errores de otros workflows

Salida:

- registro de auditoria
- actualizacion de estado
- alerta operativa futura si luego se implementa

Nodos principales:

- `Error Trigger`
- `Code`
- `Postgres`

Estado:

- esta conectado como `errorWorkflow` de los workflows versionados por el script de sincronizacion
- se valido con un fallo controlado desde webhook autorizado; registra workflow, nodo y mensaje de error especifico
- la prueba reproducible esta en `scripts/ops/test-error-handler.sh`

## Reparto de nodos nativos y Code

### Nodos nativos prioritarios

- `Webhook`
- `Respond to Webhook`
- `HTTP Request`
- `Execute Workflow`
- `Postgres`
- `Merge`

### Uso recomendado de `Code`

- parseo y limpieza del payload de WhatsApp
- extraccion deterministica basica
- construccion de estructuras JSON internas
- eleccion de siguiente pregunta
- composicion del comentario de conversacion completa
- adaptacion final de payloads para ClickUp y notificaciones

### Regla de uso de Code

- usar `Code` cuando mejore claridad o reduzca complejidad real
- no mover a `Code` la persistencia principal ni reglas que sean mas seguras en SQL

## Credenciales necesarias

### Ya preparadas en el proyecto

- `EVOLUTION_API_KEY`
- `EVOLUTION_API_BASE_URL`
- `EVOLUTION_DEFAULT_INSTANCE`
- `EVOLUTION_WEBHOOK_URL`
- `CLICKUP_API_TOKEN`
- `CLICKUP_LIST_ID`
- `CLICKUP_TEAM_ID`

### Credenciales/nodos a configurar en n8n

- credencial PostgreSQL `Postgres CRM App Local`
- variables de entorno para llamadas HTTP hacia `Evolution API`
- variables de entorno para llamadas HTTP hacia ClickUp API

## Conexion PostgreSQL desde n8n

La credencial PostgreSQL dentro de `n8n` debe usar:

- host: `postgres`
- port: `5432`
- database: `crm_whatsapp_app`
- user: `postgres`
- password: valor de `POSTGRES_PASSWORD`
- schema: `public`

## Nombres de workflows versionados

- `WA - Inbound Entry`
- `WA - Conversation Orchestrator`
- `WA - Outbound Messages`
- `CRM - Lead Creation And Assignment`
- `CRM - ClickUp Sync Lead`
- `CRM - Seller Notification Dispatch`
- `AI - Lead Qualification Assistant`
- `OPS - Error Handler`

## Estructura de exportacion versionada

Los exports versionados viven en `n8n/workflows/`:

- `wa-inbound-entry.json`
- `wa-conversation-orchestrator.json`
- `wa-outbound-messages.json`
- `crm-lead-creation-and-assignment.json`
- `crm-clickup-sync-lead.json`
- `crm-seller-notification-dispatch.json`
- `ai-lead-qualification-assistant.json`
- `ops-error-handler.json`

Los enlaces entre workflows se versionan por nombre en `n8n/workflow-links.json`. Los IDs visibles dentro de los exports de `n8n` no son la fuente de verdad: `scripts/dev/sync-n8n-workflows.sh` importa con el CLI oficial, consulta los IDs actuales de la instancia y genera copias temporales resueltas antes de reimportar.

Comandos recomendados:

```bash
sh scripts/dev/sync-n8n-workflows.sh --preflight
sh scripts/dev/sync-n8n-workflows.sh
```

El script tambien configura `OPS - Error Handler` como `errorWorkflow` de todos los workflows versionados, excepto el propio handler.

## Libreria de queries SQL

Las queries versionadas para los nodos `Postgres` viven en:

- [db/queries/n8n/README.md](/Users/juanpablovonmarttens/Documents/Automatización%20/crm-whatsapp-automatizado/db/queries/n8n/README.md)
- [db/queries/n8n/wa-conversation-orchestrator/01_load_active_context.sql](/Users/juanpablovonmarttens/Documents/Automatización%20/crm-whatsapp-automatizado/db/queries/n8n/wa-conversation-orchestrator/01_load_active_context.sql)
- [db/queries/n8n/crm-lead-creation-and-assignment/04_assign_next_seller.sql](/Users/juanpablovonmarttens/Documents/Automatización%20/crm-whatsapp-automatizado/db/queries/n8n/crm-lead-creation-and-assignment/04_assign_next_seller.sql)
- [db/queries/n8n/crm-clickup-sync-lead/01_load_clickup_task_context.sql](/Users/juanpablovonmarttens/Documents/Automatización%20/crm-whatsapp-automatizado/db/queries/n8n/crm-clickup-sync-lead/01_load_clickup_task_context.sql)

Cada workflow tiene un set de queries versionadas en `db/queries/n8n/` para:

- lectura de contexto
- escritura de dominio
- auditoria
- round robin
- sincronizacion con ClickUp
- notificacion y manejo de errores

## Secuencia operativa esperada

1. WhatsApp entrega webhook a `WA - Inbound Entry`
2. el payload canonico pasa a `WA - Conversation Orchestrator`
3. si `AI_LEAD_ASSISTANT_ENABLED=true`, el orquestador consulta `AI - Lead Qualification Assistant` cuando el mensaje trae contexto util o confirmacion
4. el orquestador valida la decision de Hormi Atencion contra reglas locales y estado confirmado
5. si corresponde responder, llama a `WA - Outbound Messages`
6. si corresponde crear lead, llama a `CRM - Lead Creation And Assignment`
7. luego llama a `CRM - ClickUp Sync Lead`
8. despues llama a `CRM - Seller Notification Dispatch`
9. cualquier error relevante pasa a `OPS - Error Handler`

## Lo que queda para la siguiente fase

- sincronizar workflows versionados en la instancia viva y confirmar que `WA - Inbound Entry` queda activo
- ejecutar baseline con AI apagada como comparacion
- definir proveedor/modelo de API directa y cargar `AI_DIRECT_API_KEY` solo en `.env`
- validar `AI - Lead Qualification Assistant` con mocks y luego con proveedor real controlado
- seguir `docs/ai-api-directa-configuracion.md`
- ejecutar matriz conversacional con AI encendida y fallbacks de baja confianza/error del proveedor
