# Bitacora de Validacion Real y Decision AI

## Objetivo

Documentar los cambios realizados durante la validacion real del CRM WhatsApp Automatizado y dejar registrada la decision tecnica sobre la futura incorporacion de AI.

Este documento complementa:

- [`docs/handoff-actual.md`](./handoff-actual.md)
- [`PLAN_DE_ACCION_OPTIMIZADO.md`](../PLAN_DE_ACCION_OPTIMIZADO.md)
- [`docs/n8n-workflows.md`](./n8n-workflows.md)

## Estado Antes de Esta Iteracion

El proyecto ya tenia:

- infraestructura local con `Docker Compose`
- `n8n`, `PostgreSQL`, `Redis` y `Evolution API`
- base CRM separada de la base interna de `n8n`
- workflows reales versionados
- ClickUp configurado y validado con una prueba previa
- plan optimizado documentado para avanzar hacia produccion

Lo que faltaba validar era el flujo real completo con WhatsApp conectado.

## Cambios Realizados

### 1. Checkpoint del repositorio

Se ordeno el estado del repo y se creo un checkpoint con la migracion a `Evolution API`, workflows reales, documentacion y scripts.

Commit:

- `22f7115 chore: checkpoint evolution whatsapp crm workflows`

### 2. Conexion real de WhatsApp

Se genero y escaneo el QR de la instancia `principal` en `Evolution API`.

Resultado:

- instancia `principal`: `open`
- runtime `Evolution API`: `2.3.7`
- webhook persistido apuntando a `n8n`

### 3. Sincronizacion de workflows

Se uso:

```bash
sh scripts/dev/sync-n8n-workflows.sh --preflight
sh scripts/dev/sync-n8n-workflows.sh
```

Resultado:

- workflows importados en `n8n`
- enlaces entre sub-workflows resueltos
- `OPS - Error Handler` conectado como error workflow
- `WA - Inbound Entry` reactivado y `n8n` reiniciado

### 4. Correcciones conversacionales

Durante la prueba real por WhatsApp aparecieron errores de flujo deterministico. Se corrigieron en commits separados.

#### Saludo inicial

Problema:

- el primer `Hola` respondia con `No logré entender bien tu respuesta`.

Cambio:

- un saludo inicial ahora responde bienvenida y pregunta por ciudad.

Commit:

- `65e1124 fix: handle initial whatsapp greetings`

#### Respuesta directa de servicio

Problema:

- al responder `Baldosas`, el bot repetia `¿Qué servicio estás buscando?`.

Cambio:

- respuestas cortas y razonables al paso `service` se aceptan como servicio.

Commit:

- `86eea4c fix: accept direct service answers`

#### Loops conversacionales

Problema:

- respuestas como `Comprar` o `Quiero comprar` repetian la pregunta de requerimiento aunque ya existia contexto suficiente.

Cambio:

- se agrego interpretacion por contexto:
  - deteccion de intencion
  - deteccion de servicio/producto
  - deteccion de ciudad
  - construccion de requerimiento inferido, por ejemplo `Comprar baldosas`
  - anti-loop para no repetir exactamente la misma pregunta

Commit:

- `374df38 fix: prevent conversational loops`

#### Comando de nueva solicitud

Problema:

- al responder `nueva` para iniciar otra solicitud, esa palabra podia terminar guardada como servicio.

Cambio:

- `nueva` reinicia el flujo y pregunta ciudad, sin reutilizar ese texto como dato del lead.

Commit:

- `7103479 fix: reset previous context without reusing command`

### 5. Validacion real end-to-end

Se valido con mensajes reales por WhatsApp que el sistema:

- recibe mensajes desde `Evolution API`
- ejecuta `WA - Inbound Entry`
- mantiene estado conversacional en PostgreSQL
- responde por WhatsApp
- crea lead en PostgreSQL
- asigna vendedor por round robin
- crea tarea en ClickUp

Tareas ClickUp creadas durante la validacion:

- lead `14`
  - tarea ClickUp: `86ah3h2ew`
  - URL: `https://app.clickup.com/t/86ah3h2ew`
  - vendedor: `Valentina Rojas`
- lead `15`
  - tarea ClickUp: `86ah3h2m6`
  - URL: `https://app.clickup.com/t/86ah3h2m6`
  - vendedor: `Martina Perez`
- lead `16`
  - tarea ClickUp: `86ah3h2q6`
  - URL: `https://app.clickup.com/t/86ah3h2q6`
  - vendedor: `Camila Soto`

Estado de esos datos:

- fueron identificados como datos de prueba
- fueron revisados y marcados/gestionados como prueba en ClickUp
- no deben usarse para metricas comerciales reales

Commit documental:

- `c4f9c5f docs: close initial end-to-end validation`
- `589a281 docs: mark validation data as test records`

## Decision Vigente Sobre AI

Se adopto API directa como proveedor AI oficial del proyecto mediante el agente `Hormi Atencion` (`Hormi Atencion`).

Regla principal:

- **Hormi Atencion decide la conversacion asistida**
- **n8n y PostgreSQL ejecutan persistencia, ClickUp y asignacion**

Hormi Atencion se usa para:

- entender intencion del cliente
- detectar servicio/producto
- detectar ciudad
- detectar requerimiento
- identificar campos faltantes
- responder al cliente
- pedir o reconocer confirmacion
- habilitar creacion de lead cuando existan campos completos, confirmacion explicita y confianza suficiente
- generar resumen para ClickUp

Hormi Atencion no debe:

- escribir directamente en PostgreSQL
- crear tareas en ClickUp por fuera del workflow
- asignar vendedores por fuera del round robin
- saltarse la confirmacion del cliente
- reemplazar las reglas de negocio centrales

El sub-workflow vigente es:

- `AI - Lead Qualification Assistant`

Entrada prevista:

- mensaje actual
- estado conversacional actual
- ultimos mensajes relevantes
- datos ya detectados: `service`, `city`, `requirement`
- lead previo si existe

Salida prevista en JSON estructurado:

- `intent`
- `lead_quality`
- `service`
- `city`
- `requirement`
- `missing_fields`
- `should_create_lead`
- `needs_confirmation`
- `confidence`
- `reply_text`
- `clickup_summary`

## Estado Actual del Proyecto

El flujo real ya funciona a nivel funcional inicial.

Completado:

- WhatsApp conectado via `Evolution API`
- workflows sincronizados y activos donde corresponde
- conversacion real validada
- creacion de leads validada
- creacion de tareas ClickUp validada
- asignacion de vendedores validada
- datos de prueba identificados y marcados/gestionados
- decision AI documentada

Pendiente inmediato:

1. ejecutar una matriz corta de pruebas conversacionales con casos variados
2. implementar seguridad y recuperacion minima:
   - proteccion del webhook
   - backup de PostgreSQL
   - backup del volumen de `n8n`
   - prueba controlada de `OPS - Error Handler`
3. iniciar `AI - Lead Qualification Assistant` como capa controlada

## Matriz Corta de Pruebas Recomendada

Casos a probar antes de pasar a AI:

- saludo simple
- mensaje completo desde el inicio
- respuestas fuera de orden
- comprador con datos incompletos
- rechazo o correccion en confirmacion
- nuevo lead desde numero repetido
- confirmacion final
- respuesta vaga o ambigua

Objetivo:

- detectar bugs criticos restantes sin seguir intentando perfeccionar indefinidamente reglas deterministicas
- mantener el flujo actual como base y fallback antes de incorporar AI
