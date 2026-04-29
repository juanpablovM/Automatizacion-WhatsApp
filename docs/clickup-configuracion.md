# Configuracion ClickUp

## Objetivo

Definir la configuracion recomendada de ClickUp para que el CRM automatizado sea consistente, portable y facil de integrar con `n8n`.

## Estado actual

ClickUp ya fue configurado y validado con el workflow `CRM - ClickUp Sync Lead`.

Estado validado:

- lista real `Leads Entrantes`
- custom fields reales mapeados por variables `CLICKUP_*`
- creacion de tareas desde leads confirmados
- asignacion inicial a vendedores activos con `clickup_user_id`
- comentario `Conversación Completa Cliente` creado desde el historial conversacional
- notificacion interna al vendedor mediante comentario asignado

Las tareas creadas durante la validacion real estan documentadas como datos de prueba en [`docs/handoff-actual.md`](./handoff-actual.md).

## Enfoque recomendado

Se recomienda usar:

- una lista dedicada llamada `Leads Entrantes`
- el estado operativo principal del lead como `task status` nativo de ClickUp
- los datos del cliente y del canal en `custom fields`
- el historial completo del cliente en un comentario separado
- los adjuntos cargados directamente a la tarea cuando la integracion este operativa

## Estructura recomendada de la tarea

### Nombre de la tarea

Formato:

- `Nombre - Servicio - Ciudad`

Ejemplo:

- `María Pérez - Servicio Técnico - Santiago`

### Descripcion

La descripcion debe contener:

- resumen breve del lead
- telefono
- canal
- requerimiento resumido
- referencia de WhatsApp si aplica

### Comentario adicional

Se recomienda agregar un comentario separado con el titulo:

- `Conversación Completa Cliente`

Ese comentario debe incluir el historial conversacional completo para no sobrecargar la descripcion principal.

## Campos recomendados

### Campos minimos

1. `Nombre WhatsApp`
- tipo recomendado: `short_text`
- uso: guardar el nombre crudo del contacto tal como llega por WhatsApp

2. `Telefono`
- tipo recomendado: `phone`
- uso: numero del lead con codigo de pais

3. `Servicio`
- tipo recomendado: `short_text`
- uso: mantener flexibilidad mientras no exista catalogo cerrado

4. `Ciudad`
- tipo recomendado: `short_text`
- uso: mantener flexibilidad mientras no exista catalogo cerrado

5. `Requerimiento`
- tipo recomendado: `text`
- uso: requerimiento libre del cliente

6. `Canal`
- tipo recomendado: `drop_down`
- opcion minima inicial:
  - `WhatsApp`
- uso: dejar preparado el modelo para futuro multicanal

### Campos recomendados adicionales

7. `Lead ID Interno`
- tipo recomendado: `short_text`
- uso: vincular la tarea con el `id` interno del CRM y simplificar sincronizacion, depuracion y portabilidad

8. `Numero de Ingreso`
- tipo recomendado: `short_text`
- uso: identificar a que numero propio de WhatsApp escribio el cliente

## Campos que no recomiendo modelar como custom field por ahora

- `Estado del lead`
  - mejor usar `task status` nativo de ClickUp

- `Vendedor asignado`
  - mejor usar `assignee` nativo de ClickUp

- `Adjuntos`
  - deben ir como adjuntos reales, no como campo

## Mapeo recomendado

### Datos del CRM hacia ClickUp

- `task.name`:
  - `Nombre WhatsApp - Servicio - Ciudad`

- `assignees`:
  - `clickup_user_id` del vendedor asignado; el round robin actual solo considera vendedores activos con este dato

- `custom field Nombre WhatsApp`:
  - `whatsapp_name`

- `custom field Telefono`:
  - `phone_number`

- `custom field Servicio`:
  - `service`

- `custom field Ciudad`:
  - `city`

- `custom field Requerimiento`:
  - `requirement`

- `custom field Canal`:
  - opcion `WhatsApp`

- `custom field Lead ID Interno`:
  - `lead.id`

- `custom field Numero de Ingreso`:
  - `source_number_id` o numero propio recibido desde WhatsApp

## Variables preparadas en el proyecto

El proyecto usa variables para los IDs de ClickUp. En `.env.example` quedan placeholders y en `.env` local se mantienen los valores reales:

- `CLICKUP_LIST_ID`
- `CLICKUP_TEAM_ID`
- `CLICKUP_CF_WHATSAPP_NAME_ID`
- `CLICKUP_CF_PHONE_ID`
- `CLICKUP_CF_SERVICE_ID`
- `CLICKUP_CF_CITY_ID`
- `CLICKUP_CF_REQUIREMENT_ID`
- `CLICKUP_CF_CHANNEL_ID`
- `CLICKUP_CF_CHANNEL_OPTION_WHATSAPP_ID`
- `CLICKUP_CF_INTERNAL_LEAD_ID`
- `CLICKUP_CF_SOURCE_NUMBER_ID`

## Notas de API

- ClickUp trabaja con `field_id`, no con nombres de campo
- para campos `drop_down`, el valor enviado debe ser el `option_id`, no el texto visible
- si mas adelante cambias el nombre visible de un campo, el `field_id` sigue siendo la referencia estable

## Siguiente paso

Para ClickUp, el siguiente trabajo no es conectar desde cero sino endurecer operacion:

1. revisar que los datos de prueba no se mezclen con metricas comerciales
2. cargar `clickup_user_id` real para cada vendedor que deba recibir leads
3. validar los reintentos con backoff de creacion de tarea y comentarios usando fallos simulados
4. definir como se manejaran adjuntos reales en la tarea
