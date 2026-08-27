# Fuentes Comerciales AI

## Objetivo

Definir como cargar y mantener las fuentes comerciales que usara `Hormi Atencion` como asesor comercial AI.

Estas fuentes son la unica base autorizada para recomendar productos, informar precios, responder condiciones sensibles o proponer agenda.

## Estado actual

Ya existe estructura versionada para:

- catalogo: `catalog_categories`, `catalog_items`, `catalog_item_media`
- condiciones comerciales: `commercial_conditions`
- precios: `price_rules`
- preguntas frecuentes: `faq_entries`
- objeciones: `objection_playbooks`
- agenda: `appointment_slots`, `appointment_bookings`
- cotizaciones preliminares: `quote_drafts`
- auditoria AI: `advisor_decisions`

La query base para n8n es:

- `db/queries/n8n/ai-sales-advisor/01_load_commercial_context.sql`

Estado cargado actualmente:

- catalogo publico Hormiglass: 28 productos/servicios activos
- reglas de precio publicas: 28 reglas activas
- condiciones comerciales: 8 activas
- FAQ: 12 activas
- objeciones: 5 activas
- agenda: pendiente
- workflow AI: carga contexto comercial activo antes de llamar al proveedor
- auditoria AI en `advisor_decisions`: conectada desde `WA - Conversation Orchestrator`

## Aplicar migracion

Con el stack local levantado:

```bash
docker compose --env-file .env exec -T postgres \
  psql -U postgres -d crm_whatsapp_app \
  < infra/postgres/migrations/004_create_commercial_advisor_tables.sql
```

La migracion es idempotente: usa `CREATE TABLE IF NOT EXISTS`, recrea triggers con `DROP TRIGGER IF EXISTS` y crea indices con `CREATE INDEX IF NOT EXISTS`.

## Cargar datos comerciales

No cargar datos operativos sensibles en `db/seeds/005_commercial_advisor.example.sql`. Ese archivo es solo plantilla.

Los datos publicos, como catalogo publicado y precios publicos, pueden quedar en seeds versionados. El catalogo actual vive en:

- `db/seeds/006_catalogo_hormiglass.sql`
- `db/seeds/007_catalogo_hormiglass_actualizacion.sql`

Los datos privados o aun no aprobados deben ir en una ruta ignorada por Git, por ejemplo:

```text
.local/private-seeds/commercial_advisor.sql
```

Ejecutar el seed privado asi:

```bash
docker compose --env-file .env exec -T postgres \
  psql -U postgres -d crm_whatsapp_app \
  < .local/private-seeds/commercial_advisor.sql
```

Estos comandos leen el archivo desde el host y envian el SQL por stdin al contenedor. No requieren montar `.local/` dentro de Postgres.

## Orden recomendado de carga

1. `catalog_categories`
2. `catalog_items`
3. `catalog_item_media`
4. `commercial_conditions`
5. `price_rules`
6. `faq_entries`
7. `objection_playbooks`
8. `appointment_slots`, solo si se ofrecera agenda real

Estado de avance:

- pasos 1, 2, 4, 5, 6 y 7 tienen una primera carga versionada
- el paso 8 queda diferido hasta contar con agenda real y confirmable

## Reglas por fuente

### Catalogo

Cada item debe tener:

- nombre comercial claro
- tipo: `product`, `service`, `bundle` u `other`
- descripcion breve
- palabras clave utiles para busqueda
- restricciones si aplica
- estado activo solo si puede recomendarse al cliente

### Precios

Usar `price_rules.price_type` segun corresponda:

- `fixed`: precio final conocido
- `from`: precio desde
- `range`: rango referencial
- `formula`: requiere calculo estructurado
- `requires_human`: no informar monto; derivar o pedir datos

Si el precio depende de medidas, stock, despacho o instalacion, marcarlo como referencial con `is_reference = TRUE` y detallar condiciones en `conditions`.

### Condiciones comerciales

Usar condiciones aprobadas y vigentes para:

- pago
- garantia
- despacho
- instalacion
- cambios o devoluciones
- cotizacion final
- descuentos o promociones

No cargar condiciones informales que un vendedor no pueda respaldar.

### FAQ y objeciones

Las respuestas deben estar escritas para WhatsApp:

- cortas
- claras
- sin promesas no verificables
- con criterio de derivacion cuando corresponda

### Agenda

Solo cargar `appointment_slots` si existe un proceso real para mantenerlos actualizados.

La AI no debe confirmar un horario si:

- el slot no existe
- el slot no esta `available`
- `booked_count >= capacity`
- el workflow no puede crear o confirmar la reserva

## Validacion minima antes de conectar AI

Ejecutar consultas manuales:

```sql
SELECT count(*) FROM catalog_items WHERE deleted_at IS NULL AND is_active = TRUE;
SELECT count(*) FROM commercial_conditions WHERE deleted_at IS NULL AND is_active = TRUE;
SELECT count(*) FROM faq_entries WHERE deleted_at IS NULL AND is_active = TRUE;
SELECT count(*) FROM objection_playbooks WHERE deleted_at IS NULL AND is_active = TRUE;
SELECT count(*) FROM price_rules WHERE deleted_at IS NULL AND is_active = TRUE;
```

Para agenda:

```sql
SELECT id, slot_type, starts_at, ends_at, city, capacity, booked_count, status
FROM appointment_slots
WHERE deleted_at IS NULL
  AND status = 'available'
  AND starts_at > NOW()
ORDER BY starts_at
LIMIT 20;
```

## Criterio de habilitacion

El workflow AI ya puede consultar catalogo y precios. Para habilitarlo en una instancia viva:

- catalogo activo revisado
- reglas de precio probadas si se informaran montos
- workflows sincronizados en `n8n`
- proveedor AI real o mock controlado validado
- `n8n` registra decisiones en `advisor_decisions`
- existe fallback si no hay contexto comercial suficiente

Las respuestas sobre condiciones comerciales, FAQ y objeciones estan habilitadas contra sus fuentes activas. La agenda permanece bloqueada hasta cargar cupos reales y validar su reserva.

## Prohibido para produccion

- precios privados o no publicados en archivos versionados
- descuentos privados en Git
- agenda real en Git
- condiciones sensibles en Git
- respuestas comerciales inventadas en el prompt
- confirmar agenda o precio final sin validacion del workflow
