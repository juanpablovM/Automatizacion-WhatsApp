# Base de Datos

## Objetivo

Documentar el diseno de persistencia del proyecto y su evolucion mediante migraciones.

## Estado actual

La base inicial ya fue implementada en migraciones SQL versionadas y seeds de catalogos. En el entorno local validado ya existen datos operativos de prueba generados por la validacion real del flujo WhatsApp -> ClickUp.

La arquitectura de persistencia queda separada asi:

- `crm_whatsapp`: base interna de `n8n`
- `crm_whatsapp_app`: base del CRM y la automatizacion de negocio
- `evolution_api`: base tecnica usada por `Evolution API`

## Principios aplicados

- `PostgreSQL` como base principal
- modelo extensible desde el inicio
- separacion clara entre leads, conversaciones, mensajes, asignaciones, vendedores y auditoria
- borrado logico
- convencion tecnica en ingles con `snake_case` y plural
- estados con `code` tecnico en ingles y `label` operativo en espanol

## Estructura del proyecto relacionada

- `infra/postgres/migrations/`: migraciones versionadas
- `db/schema/`: documentacion del modelo
- `db/seeds/`: datos iniciales versionados
- `db/queries/`: consultas utiles de operacion y soporte

## Migraciones implementadas

- `001_create_status_catalogs.sql`
  - crea la funcion `set_updated_at()`
  - crea `lead_statuses`
  - crea `conversation_statuses`

- `002_create_operational_tables.sql`
  - crea `whatsapp_numbers`
  - crea `sellers`
  - crea `assignment_rotations`
  - crea `leads`
  - crea `conversations`
  - crea `messages`
  - crea `message_attachments`
  - crea `lead_assignments`
  - crea `audit_logs`

- `003_create_indexes.sql`
  - crea indices operativos
  - crea unicidad parcial para registros activos

- `004_create_commercial_advisor_tables.sql`
  - crea fuentes comerciales para el asesor AI
  - crea catalogo, condiciones, reglas de precio, FAQ, objeciones, agenda, cotizaciones preliminares y decisiones AI auditables

- `005_create_conversation_memory_indexes.sql`
  - optimiza la lectura de historial por conversacion
  - optimiza la busqueda del ultimo reinicio de solicitud

- `006_add_conversation_qualification_context.sql`
  - agrega `conversations.qualification_context`
  - agrega `conversations.pending_question_key`
  - agrega `leads.qualification_context`
  - crea indices para memoria y preguntas pendientes

## Seeds implementados

- `001_lead_statuses.sql`
- `002_conversation_statuses.sql`
- `003_sellers.example.sql`
- `004_whatsapp_numbers.example.sql`
- `005_commercial_advisor.example.sql`
- `006_catalogo_hormiglass.sql`
- `007_catalogo_hormiglass_actualizacion.sql`

Los seeds `003`, `004` y `005` son ejemplos operativos. Los seeds `006` y `007` cargan catalogo publico Hormiglass y reglas de precio publicas. Las condiciones, FAQ y objeciones activas del entorno deben revisarse como contenido aprobado; agenda y datos sensibles deben mantenerse fuera de Git cuando correspondan.

## Dominios cubiertos por la base actual

- leads historicos por telefono
- conversaciones separadas del lead
- mensajes entrantes y salientes con payload crudo
- metadata de adjuntos
- vendedores y round robin persistente
- historial de asignaciones
- auditoria general
- catalogos de estados
- fuentes comerciales para asesor AI: catalogo, precios, condiciones, FAQ, objeciones y agenda

## Fuentes comerciales del asesor AI

La migracion `004_create_commercial_advisor_tables.sql` contiene las fuentes estructuradas que usa `Hormi Atencion` como asesor comercial AI.

Tablas principales:

- `catalog_categories`: categorias comerciales del catalogo
- `catalog_items`: productos, servicios, paquetes u otros items recomendables
- `catalog_item_media`: imagenes, videos, documentos o links asociados al catalogo
- `commercial_conditions`: condiciones aprobadas de pago, garantia, despacho, instalacion, cambios, descuentos o cotizacion
- `price_rules`: precios fijos, precios desde, rangos, formulas o marcadores de revision humana
- `faq_entries`: preguntas frecuentes con respuestas aprobadas
- `objection_playbooks`: respuestas sugeridas para objeciones comerciales
- `appointment_slots`: disponibilidad real o controlada para llamadas, visitas, mediciones, retiros o despachos
- `appointment_bookings`: solicitudes o reservas de agenda vinculadas a conversaciones y leads
- `quote_drafts`: cotizaciones preliminares o borradores de precio
- `advisor_decisions`: decisiones estructuradas de la AI con validacion y payloads auditables

Regla operativa:

- la AI puede recomendar o responder usando estas tablas, pero `n8n` debe validar antes de informar precios, ofrecer agenda, crear cotizaciones o cerrar compromisos.
- los precios publicos pueden versionarse; precios privados, descuentos privados, agenda real y condiciones sensibles no deben versionarse en este repositorio.
- si no hay fuente oficial, la AI debe preguntar, derivar o indicar que requiere validacion.

Estado actual de fuentes comerciales:

- `catalog_items`: 28 productos/servicios publicos Hormiglass cargados
- `price_rules`: 28 reglas de precio publicas cargadas
- `commercial_conditions`: 8 activas en el entorno validado
- `faq_entries`: 12 activas
- `objection_playbooks`: 5 activos
- `appointment_slots`: pendiente
- `advisor_decisions`: insercion conectada desde el orquestador conversacional cuando la AI esta habilitada

## Memoria comercial

`conversations.qualification_context` conserva el diagnostico acumulado sin depender del texto generado por la AI. Incluye, cuando aplica:

- modalidad, medidas, cantidad y uso
- terreno, acceso de camion y retiro de escombros
- urgencia, fotos y fecha deseada
- tipo de cliente y datos B2B
- D.A.T.O.S., clasificacion, objecion y resumen ejecutivo

`pending_question_key` indica la pregunta principal vigente. De esta forma, una respuesta `si/no` se aplica al dato correcto y no se interpreta automaticamente como confirmacion o rechazo global.

Al crear el lead, `qualification_context` se copia a `leads` y queda disponible para ClickUp y ventas.

## Estado runtime observado

En el entorno local usado para validacion existen registros reales de prueba:

- leads creados por el flujo
- conversaciones con estado `waiting_user` y `handed_to_sales`
- mensajes entrantes y salientes
- vendedores cargados para round robin
- auditorias de conversacion, ClickUp, notificacion y envio Evolution

Los datos de validacion no deben usarse como metricas comerciales.

## Readiness de vendedores y ClickUp

La tabla `sellers` mezcla configuracion comercial con datos tecnicos de entrega. Para que un vendedor sea notificable y pueda recibir leads por round robin debe cumplir todo esto:

- `deleted_at IS NULL`
- `is_active = TRUE`
- `clickup_user_id` con valor no vacio

El `clickup_user_id` es obligatorio para vendedores notificables porque se usa en dos puntos:

- como `assignee` de la tarea creada en ClickUp
- como destinatario del comentario de notificacion interna en `CRM - Seller Notification Dispatch`

Un vendedor activo sin `clickup_user_id` no debe recibir leads en produccion. Puede quedar cargado como dato incompleto, vendedor futuro o registro historico, pero no entra al round robin actual.

### Revision vendedor real vs prueba

Sin leer `.env` ni consultar servicios externos, la revision se debe hacer desde PostgreSQL con consultas read-only:

```bash
docker compose --env-file .env exec -T postgres \
  psql -U postgres -d crm_whatsapp_app \
  -f db/queries/ops/clickup-readiness/01_seller_notifiability_audit.sql
```

Interpretacion:

- `readiness_status = notifiable`: vendedor activo y listo para recibir leads
- `missing_clickup_user_id`: vendedor activo que debe completarse o desactivarse antes de operar
- `inactive` o `deleted`: no participa en asignacion
- `looks_like_test_data = true`: revisar manualmente si corresponde a vendedor de prueba, demo o QA
- `active_sellers_sharing_clickup_user_id > 1`: corregir antes de produccion, salvo que sea una decision explicita

Checklist minimo antes de produccion:

- confirmar nombres reales de vendedores activos
- confirmar numero WhatsApp de contacto si se usara fuera de ClickUp
- cargar `clickup_user_id` real para cada vendedor que deba recibir leads
- desactivar o borrar logicamente vendedores de prueba
- verificar que `sort_order` represente el orden deseado de round robin
- confirmar que no hay duplicados de `clickup_user_id` entre vendedores activos

## Round robin y `no_notifiable_seller`

Las queries versionadas y el workflow `CRM - Lead Creation And Assignment` solo consideran vendedores notificables. El puntero `assignment_rotations.next_seller_id` se recalcula si apunta a un vendedor no notificable.

Si no existe ningun vendedor notificable, el lead se crea pero la asignacion queda fallida en `lead_assignments` con:

- `assignment_result = failed`
- `reason = no_notifiable_seller`

Consulta de revision:

```bash
docker compose --env-file .env exec -T postgres \
  psql -U postgres -d crm_whatsapp_app \
  -f db/queries/ops/clickup-readiness/02_round_robin_readiness.sql
```

Accion esperada si aparece `BLOCKER: no_notifiable_seller`:

- cargar al menos un `clickup_user_id` real en un vendedor activo, o
- activar un vendedor real ya configurado, o
- pausar pruebas end-to-end que esperen ClickUp/notificacion hasta corregir datos

## Datos de validacion y metricas

El esquema actual no tiene un campo formal para marcar ambiente, prueba o validacion. Por ahora el criterio operativo es:

- no usar leads/tareas documentados como validacion para metricas comerciales
- excluir telefonos sinteticos usados en pruebas
- excluir registros cuyo nombre, servicio, ciudad o requerimiento contenga marcadores obvios como `test`, `prueba`, `demo`, `qa`, `smoke` o `validacion`
- revisar manualmente cualquier tarea ClickUp creada durante pruebas reales antes de abrir reportes comerciales

Consultas disponibles:

```bash
docker compose --env-file .env exec -T postgres \
  psql -U postgres -d crm_whatsapp_app \
  -f db/queries/ops/clickup-readiness/03_validation_data_candidates.sql

docker compose --env-file .env exec -T postgres \
  psql -U postgres -d crm_whatsapp_app \
  -f db/queries/ops/clickup-readiness/04_metrics_excluding_validation.sql
```

Pendiente recomendado para una fase posterior: agregar una marca formal de origen/ambiente, por ejemplo una tabla auxiliar de exclusiones o una columna controlada, para no depender de heuristicas en reportes.

## Documentacion complementaria

- [Resumen del esquema](../db/schema/overview.md)

## Ejecucion prevista

Orden esperado cuando el entorno local ya este levantado:

1. ejecutar migraciones de `infra/postgres/migrations/`
2. ejecutar seeds de `db/seeds/`

### Comandos manuales sugeridos

Con `PostgreSQL` ya levantado en Docker:

```bash
docker compose --env-file .env exec -T postgres \
  psql -U postgres -d crm_whatsapp_app \
  < infra/postgres/migrations/001_create_status_catalogs.sql

docker compose --env-file .env exec -T postgres \
  psql -U postgres -d crm_whatsapp_app \
  < infra/postgres/migrations/002_create_operational_tables.sql

docker compose --env-file .env exec -T postgres \
  psql -U postgres -d crm_whatsapp_app \
  < infra/postgres/migrations/003_create_indexes.sql

docker compose --env-file .env exec -T postgres \
  psql -U postgres -d crm_whatsapp_app \
  < infra/postgres/migrations/004_create_commercial_advisor_tables.sql

docker compose --env-file .env exec -T postgres \
  psql -U postgres -d crm_whatsapp_app \
  < infra/postgres/migrations/005_create_conversation_memory_indexes.sql

docker compose --env-file .env exec -T postgres \
  psql -U postgres -d crm_whatsapp_app \
  < db/seeds/001_lead_statuses.sql

docker compose --env-file .env exec -T postgres \
  psql -U postgres -d crm_whatsapp_app \
  < db/seeds/002_conversation_statuses.sql
```

Estos comandos suponen que mantienes los valores por defecto de `.env` para:

- `POSTGRES_USER=postgres`
- `POSTGRES_DB=crm_whatsapp`
- `APP_POSTGRES_DB=crm_whatsapp_app`

## Pendientes

- automatizar la ejecucion de migraciones y seeds si mas adelante lo apruebas
- revisar o reemplazar vendedores de prueba por vendedores reales antes de operar comercialmente
- cargar `clickup_user_id` real en cada vendedor activo que deba recibir leads
- definir marca formal para excluir datos de validacion en metricas comerciales
- cargar o documentar numeros reales de WhatsApp si se operaran multiples numeros
- ampliar consultas operativas iniciales mas alla de readiness ClickUp/round robin
- sincronizar y validar el workflow AI que ya carga catalogo y precios publicos
- definir condiciones comerciales, FAQ, objeciones y agenda cuando exista informacion aprobada
- validar inserciones reales en `advisor_decisions` con proveedor AI o mock controlado
- probar restore desde los backups generados por `scripts/ops/backup-local.sh`; existe verificacion no destructiva en `scripts/ops/verify-backup-local.sh`
