# Arquitectura n8n

## Objetivo

Definir la arquitectura de workflows de `n8n` para implementar la automatizacion de leads por WhatsApp sin dejar decisiones abiertas para la siguiente fase.

## Principios de diseno

- `n8n` actua como orquestador de eventos, integraciones y reintentos
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
- llamadas a WhatsApp
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

### Capa 2: extraccion asistida por IA

Se deja preparada como mejora o capa complementaria:

- tomar un mensaje libre amplio del cliente
- proponer `service`, `city` y `requirement`
- devolver estructura JSON controlada
- nunca sustituir la persistencia ni la logica central

Regla:

- la IA complementa, no gobierna el estado del sistema

## Workflows propuestos

### 1. `wa_inbound_entry`

Responsabilidad:

- recibir eventos entrantes desde WhatsApp
- validar challenge del webhook cuando corresponda
- normalizar el payload inicial
- enrutar eventos utiles al procesamiento conversacional

Entrada:

- webhook HTTP desde WhatsApp Cloud API

Salida:

- payload canonico de mensaje entrante
- derivacion a workflow de procesamiento

Nodos principales:

- `Webhook`
- `IF`
- `Respond to Webhook`
- `Code`
- `Execute Workflow`

Notas:

- debe soportar mensajes y verificacion de webhook
- debe detectar rapidamente si el evento no corresponde a mensaje util

### 2. `conversation_orchestrator`

Responsabilidad:

- leer el estado conversacional actual
- registrar mensaje y payload
- recuperar o crear conversacion
- decidir el siguiente paso
- persistir cambios del dominio
- decidir si continua preguntando o si pasa a creacion de lead

Entrada:

- payload canonico desde `wa_inbound_entry`

Salida:

- mensaje de respuesta al cliente
- o senal de crear lead
- o senal de error

Nodos principales:

- `Execute Query` o `Postgres`
- `Code`
- `Switch`
- `IF`
- `Execute Workflow`

Uso de `Code`:

- consolidacion de contexto conversacional
- deteccion de campos ya respondidos
- seleccion de pregunta pendiente
- conteo de intentos de comprension
- evaluacion `2 de 3 + intencion`

Uso de IA:

- subpaso opcional cuando el mensaje libre trae bastante contexto
- resultado siempre validado antes de persistir

### 3. `wa_outbound_messages`

Responsabilidad:

- enviar mensajes salientes al cliente por WhatsApp
- aplicar reintentos
- registrar auditoria y estado del envio

Entrada:

- payload de mensaje saliente estructurado

Salida:

- resultado del envio
- evento de error si no pudo enviarse

Nodos principales:

- `HTTP Request`
- `Code`
- `IF`
- `Wait`
- `Execute Query` o `Postgres`

Casos cubiertos:

- bienvenida
- pregunta pendiente
- reencauce
- derivacion final

### 4. `lead_creation_and_assignment`

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

- `Execute Query` o `Postgres`
- `Code`
- `IF`
- `Execute Workflow`

Uso de SQL:

- lectura de lead previo
- escritura del lead
- actualizacion del puntero de round robin
- insercion en `lead_assignments`
- auditoria

### 5. `clickup_sync_lead`

Responsabilidad:

- construir el payload de ClickUp
- crear la tarea en `Leads Entrantes`
- asignar vendedor si existe `clickup_user_id`
- cargar comentario con conversacion completa
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
- `IF`
- `Wait`
- `Execute Query` o `Postgres`

Notas:

- los custom fields se parametrizan cuando se definan en ClickUp
- la conversacion completa se publica como comentario

### 6. `seller_notification_dispatch`

Responsabilidad:

- enviar la notificacion al vendedor
- dejar el canal desacoplado
- soportar reintentos
- registrar incidente operativo si falla

Entrada:

- lead listo y tarea de ClickUp creada

Salida:

- confirmacion de notificacion
- o incidente operativo

Nodos principales:

- `Switch`
- `HTTP Request`
- `Code`
- `Wait`
- `Execute Query` o `Postgres`

Diseño:

- subworkflow abstracto
- canal primario: WhatsApp interno
- respaldo operativo: ClickUp
- mas adelante puede admitir otro canal sin cambiar el resto

### 7. `operational_error_handler`

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
- `Execute Query` o `Postgres`
- `IF`

## Reparto de nodos nativos y Code

### Nodos nativos prioritarios

- `Webhook`
- `Respond to Webhook`
- `HTTP Request`
- `IF`
- `Switch`
- `Wait`
- `Execute Workflow`
- `Postgres` o `Execute Query`

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

- `WHATSAPP_ACCESS_TOKEN`
- `WHATSAPP_PHONE_NUMBER_ID`
- `WHATSAPP_VERIFY_TOKEN`
- `WHATSAPP_BUSINESS_ACCOUNT_ID`
- `CLICKUP_API_TOKEN`
- `CLICKUP_LIST_ID`
- `CLICKUP_TEAM_ID`

### Credenciales/nodos a configurar en n8n

- conexion HTTP para WhatsApp Cloud API
- conexion HTTP para ClickUp API
- conexion PostgreSQL a `crm_whatsapp_app`

## Conexion PostgreSQL desde n8n

Cuando se configure la credencial PostgreSQL dentro de `n8n`, debe usar:

- host: `postgres`
- port: `5432`
- database: `crm_whatsapp_app`
- user: `postgres`
- password: valor de `POSTGRES_PASSWORD`
- schema: `public`

## Nombres recomendados de workflows

- `WA - Inbound Entry`
- `WA - Conversation Orchestrator`
- `WA - Outbound Messages`
- `CRM - Lead Creation And Assignment`
- `CRM - ClickUp Sync Lead`
- `CRM - Seller Notification Dispatch`
- `OPS - Error Handler`

## Estructura de exportacion versionada

Se recomienda guardar en `n8n/workflows/`:

- `wa-inbound-entry.json`
- `wa-conversation-orchestrator.json`
- `wa-outbound-messages.json`
- `crm-lead-creation-and-assignment.json`
- `crm-clickup-sync-lead.json`
- `crm-seller-notification-dispatch.json`
- `ops-error-handler.json`

## Libreria de queries SQL

Las queries versionadas para los nodos `Postgres` viven en:

- [db/queries/n8n/README.md](/Users/juanpablovonmarttens/Documents/Automatización%20/crm-whatsapp-automatizado/db/queries/n8n/README.md)
- [db/queries/n8n/wa-conversation-orchestrator/01_load_active_context.sql](/Users/juanpablovonmarttens/Documents/Automatización%20/crm-whatsapp-automatizado/db/queries/n8n/wa-conversation-orchestrator/01_load_active_context.sql)
- [db/queries/n8n/crm-lead-creation-and-assignment/04_assign_next_seller.sql](/Users/juanpablovonmarttens/Documents/Automatización%20/crm-whatsapp-automatizado/db/queries/n8n/crm-lead-creation-and-assignment/04_assign_next_seller.sql)
- [db/queries/n8n/crm-clickup-sync-lead/01_load_clickup_task_context.sql](/Users/juanpablovonmarttens/Documents/Automatización%20/crm-whatsapp-automatizado/db/queries/n8n/crm-clickup-sync-lead/01_load_clickup_task_context.sql)

Cada workflow ya tiene un set de queries sugeridas en `db/queries/n8n/` para:

- lectura de contexto
- escritura de dominio
- auditoria
- round robin
- sincronizacion con ClickUp
- notificacion y manejo de errores

## Secuencia operativa esperada

1. WhatsApp entrega webhook a `WA - Inbound Entry`
2. el payload canonico pasa a `WA - Conversation Orchestrator`
3. si corresponde responder, llama a `WA - Outbound Messages`
4. si corresponde crear lead, llama a `CRM - Lead Creation And Assignment`
5. luego llama a `CRM - ClickUp Sync Lead`
6. despues llama a `CRM - Seller Notification Dispatch`
7. cualquier error relevante pasa a `OPS - Error Handler`

## Lo que queda para la siguiente fase

- construir los workflows reales en `n8n`
- definir queries SQL exactas por workflow
- definir custom fields exactos de ClickUp
- conectar credenciales reales de WhatsApp y ClickUp
- decidir si se activa la capa IA desde el inicio o se deja como segundo paso
