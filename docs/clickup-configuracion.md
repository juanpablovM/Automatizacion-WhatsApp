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
- diagnostico comercial enriquecido desde `qualification_context`

Los identificadores de pruebas no se consideran configuracion permanente. El estado funcional vigente se resume en [`docs/handoff-actual.md`](./handoff-actual.md).

## Readiness de vendedores

Un vendedor solo debe considerarse listo para recibir leads si tiene `clickup_user_id` real cargado en PostgreSQL. Ese dato no es decorativo: el flujo lo usa para asignar la tarea y para crear el comentario de notificacion dirigido al vendedor.

Requisito para vendedor notificable:

- activo en `sellers.is_active`
- sin borrado logico en `sellers.deleted_at`
- `sellers.clickup_user_id` no vacio
- usuario correspondiente existe en el workspace/lista de ClickUp usada por el proyecto

El round robin actual excluye vendedores activos sin `clickup_user_id`. Si no queda ningun vendedor notificable, el flujo registra `no_notifiable_seller` en `lead_assignments` y no hay notificacion comercial util para ese lead.

Consulta recomendada antes de cualquier prueba real:

```bash
docker compose --env-file .env exec -T postgres \
  psql -U postgres -d crm_whatsapp_app \
  -f db/queries/ops/clickup-readiness/01_seller_notifiability_audit.sql

docker compose --env-file .env exec -T postgres \
  psql -U postgres -d crm_whatsapp_app \
  -f db/queries/ops/clickup-readiness/02_round_robin_readiness.sql
```

No se debe usar un `clickup_user_id` temporal de una prueba como dato definitivo de produccion.

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

- resumen ejecutivo del lead
- telefono
- canal
- requerimiento resumido
- modalidad, medidas y condiciones relevantes
- clasificacion y objeciones detectadas
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

## Datos de prueba y metricas

Las tareas ClickUp creadas durante validacion real no deben mezclarse con oportunidades comerciales ni con metricas de conversion. Mientras no exista una marca formal en el modelo, el criterio operativo es:

- identificar en ClickUp las tareas de validacion con una etiqueta, estado, prefijo o comentario interno acordado por el equipo
- excluir de reportes los IDs de lead y tareas documentados en el handoff
- excluir telefonos sinteticos y textos con marcadores de prueba
- no usar vendedores temporales ni `clickup_user_id` prestados como base de reportes de productividad

Consultas de apoyo:

```bash
docker compose --env-file .env exec -T postgres \
  psql -U postgres -d crm_whatsapp_app \
  -f db/queries/ops/clickup-readiness/03_validation_data_candidates.sql

docker compose --env-file .env exec -T postgres \
  psql -U postgres -d crm_whatsapp_app \
  -f db/queries/ops/clickup-readiness/04_metrics_excluding_validation.sql
```

Antes de declarar produccion, debe existir un criterio estable para que los reportes comerciales no dependan de memoria historica del equipo. La opcion minima es mantener una lista versionada de exclusiones; la opcion mas robusta es agregar una marca formal de ambiente o validacion en datos.

## Adjuntos ClickUp

Estado actual:

- PostgreSQL guarda metadata de adjuntos en `message_attachments`
- `CRM - ClickUp Sync Lead` ya lee `attachments_json`
- la carga del binario real como adjunto de tarea queda pendiente

No implementar adjuntos en esta fase salvo correccion menor que no altere el flujo. La implementacion futura debe resolver descarga segura desde Evolution/API origen, manejo de tamanos, MIME types, reintentos y evidencia en auditoria.

## Siguiente paso

Para ClickUp, el siguiente trabajo no es conectar desde cero sino endurecer operacion:

1. revisar que los datos de prueba no se mezclen con metricas comerciales
2. cargar `clickup_user_id` real para cada vendedor que deba recibir leads
3. validar los reintentos con backoff de creacion de tarea y comentarios usando fallos simulados
4. definir como se manejaran adjuntos reales en la tarea, sin implementarlo hasta cerrar el contrato operativo
