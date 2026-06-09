# Matriz de Pruebas Conversacionales

## Objetivo

Validar que el flujo conversacional sigue funcionando despues de introducir `AI - Lead Qualification Assistant` como capa controlada. La matriz mantiene los casos base `CP-01` a `CP-12` y agrega regresiones especificas de AI sin cambiar la regla principal: el lead solo se crea cuando existen `servicio + ciudad + requerimiento + confirmacion`.

La AI puede recomendar extracciones o una respuesta asistida. `n8n` y PostgreSQL siguen decidiendo el estado, la creacion del lead, ClickUp y la asignacion.

## Alcance

Incluye:

- entrada real o simulada desde WhatsApp via `Evolution API`
- procesamiento en `WA - Inbound Entry`
- orquestacion conversacional en `WA - Conversation Orchestrator`
- llamada opcional a `AI - Lead Qualification Assistant` cuando `AI_LEAD_ASSISTANT_ENABLED=true`
- persistencia de conversacion, mensajes, auditorias y adjuntos en PostgreSQL
- creacion de lead solo con confirmacion valida
- creacion de tarea ClickUp solo para leads confirmados
- asignacion round robin y notificacion al vendedor cuando corresponda
- fallback deterministico cuando AI esta apagada, falla, responde invalido o devuelve baja confianza

No incluye:

- pruebas de carga
- multiples instancias de WhatsApp
- restore destructivo
- agente autonomo completo
- adjuntos ClickUp como funcionalidad nueva

## Preparacion para ejecucion real

Solo el integrador debe ejecutar esta seccion con `.env` real y servicios vivos.

```bash
sh scripts/dev/evolution-doctor.sh
sh scripts/dev/sync-n8n-workflows.sh --preflight
docker compose --env-file .env ps
```

Verificar:

- `n8n` corriendo y healthcheck OK
- `postgres` healthy
- `redis` healthy
- `evolution-api` corriendo
- instancia `principal` en estado `open`
- `WA - Inbound Entry` activo en `n8n`
- vendedores reales notificables tienen `clickup_user_id`
- para pruebas con AI encendida, `AI_LEAD_ASSISTANT_ENABLED=true` y proveedor NVIDIA configurado
- para pruebas con OpenClaw, primero debe estar validado el agente `hormi-atencion` y se debe seguir `docs/openclaw-configuracion.md`
- para regresion deterministica, `AI_LEAD_ASSISTANT_ENABLED=false`

## Smoke test local sin servicios reales

El agente QA puede ejecutar esta validacion sin `.env`, NVIDIA, PostgreSQL, ClickUp ni Evolution:

```bash
sh scripts/ops/test-conversation-regression-local.sh
```

El script valida el fixture `n8n/samples/conversation_regression_cases.sample.json` y asegura que:

- existen los casos `CP-01` a `CP-12`
- existen los casos AI `AI-01` a `AI-05`
- la evidencia obligatoria esta definida
- ningun caso permite ClickUp sin lead confirmado
- ningun caso permite que AI cree leads directamente
- los escenarios de AI invalida, falla o baja confianza quedan en fallback seguro

Este smoke no sustituye la ejecucion real. Sirve para proteger la matriz y el contrato de regresion versionado.

## Evidencia requerida

Para cada caso real, registrar:

- fecha y hora
- numero usado
- mensajes enviados por el cliente
- respuestas del bot
- `conversation_id`
- `lead_id`, si se crea
- `clickup_task_id`, si se crea
- vendedor asignado, si aplica
- auditorias relevantes, especialmente eventos de orquestador, AI, ClickUp, seller notification y error handler
- estado de `AI_LEAD_ASSISTANT_ENABLED`
- resultado: `OK`, `Falla` o `Bloqueado`
- observaciones

Campos minimos de evidencia por caso:

| Campo | Obligatorio | Nota |
| --- | --- | --- |
| `conversation_id` | Si el evento es procesable | Debe existir para mensajes de cliente aceptados. |
| `lead_id` | Si se crea lead | Debe estar vacio antes de confirmacion. |
| `clickup_task_id` | Si se crea tarea | Solo permitido cuando existe `lead_id` confirmado. |
| `vendedor` | Si se asigna lead | Debe ser vendedor notificable para prueba E2E completa. |
| `auditorias` | Siempre que haya procesamiento | Deben permitir reconstruir decision deterministica o fallback AI. |

Consultas utiles:

```sql
SELECT c.id, cs.code AS status, c.phone_number, c.current_step, c.lead_id, c.last_message_at
FROM conversations c
JOIN conversation_statuses cs ON cs.id = c.conversation_status_id
ORDER BY c.id DESC
LIMIT 10;
```

```sql
SELECT l.id, ls.code AS status, l.phone_number, l.service, l.city, l.requirement,
       l.assigned_seller_id, l.clickup_task_id, l.created_at
FROM leads l
JOIN lead_statuses ls ON ls.id = l.lead_status_id
ORDER BY l.id DESC
LIMIT 10;
```

```sql
SELECT direction, COALESCE(delivery_status, 'null') AS delivery_status, count(*)
FROM messages
GROUP BY direction, delivery_status
ORDER BY direction, delivery_status;
```

```sql
SELECT entity_type, entity_id, event_type, status, created_at, details
FROM operational_audits
ORDER BY id DESC
LIMIT 30;
```

## Criterios generales de aprobacion

Un caso pasa si:

- el bot no entra en loop
- no repite una pregunta ya resuelta
- no crea lead sin `servicio + ciudad + requerimiento + confirmacion`
- persiste conversacion y mensajes correctamente
- crea lead solo cuando corresponde
- crea tarea ClickUp solo para leads confirmados
- asigna vendedor notificable cuando el flujo espera notificacion
- deja auditoria suficiente para diagnosticar el caso
- con AI apagada, el comportamiento critico se mantiene igual que antes
- con AI encendida, AI solo mejora extraccion o respuesta
- si AI falla, responde invalido o tiene baja confianza, el flujo cae a logica deterministica

## Casos base CP-01 a CP-12

| ID | Caso | Mensajes del cliente | Modo AI | Resultado esperado | Evidencia minima |
| --- | --- | --- | --- | --- | --- |
| CP-01 | Saludo simple | `Hola` | Apagada y encendida | Bot responde bienvenida y pide el primer dato faltante. No crea lead. | `conversation_id`, respuesta bot, sin `lead_id`, auditoria de decision |
| CP-02 | Mensaje completo desde el inicio | `Hola, necesito comprar baldosas en Santiago para renovar un baño` | Apagada y encendida | Detecta servicio, ciudad y requerimiento; pide confirmacion. No crea lead hasta confirmar. | `conversation_id`, campos detectados, `current_step=confirm`, sin `lead_id` |
| CP-03 | Confirmacion final | Despues de CP-02: `Si, correcto` | Apagada y encendida | Crea lead, asigna vendedor, crea tarea ClickUp y notifica si el vendedor es notificable. | `lead_id`, `clickup_task_id`, vendedor, auditorias |
| CP-04 | Respuestas fuera de orden | `Necesito instalar en Valparaiso` | Apagada y encendida | Aprovecha ciudad y requerimiento parcial, pregunta solo lo faltante. No crea lead antes de confirmacion. | campos detectados, pregunta siguiente, sin `lead_id` |
| CP-05 | Comprador con datos incompletos | `Quiero cotizar en Santiago` | Apagada y encendida | Detecta intencion y ciudad, pero pregunta producto/servicio especifico. No crea lead. | sin `lead_id`, pregunta por servicio |
| CP-06 | Respuesta directa de servicio | Despues de una pregunta por servicio: `Baldosas` | Apagada y encendida | Acepta `Baldosas` como servicio y avanza al siguiente dato faltante. | `service=Baldosas`, pregunta siguiente, auditoria |
| CP-07 | Requerimiento vago | `Algo para la casa` | Apagada y encendida | Pide aclaracion o dato mas concreto. No crea lead. AI de baja confianza no debe aceptar campos. | respuesta de aclaracion, sin `lead_id` |
| CP-08 | Rechazo en confirmacion | En confirmacion: `No, quiero corregir` | Apagada y encendida | Solicita correccion o reinicia estado sin crear lead. | `current_step` de correccion o dato faltante, sin nuevo lead |
| CP-09 | Nuevo lead desde numero repetido | Desde numero con lead previo: `nueva` o `quiero hacer otra solicitud` | Apagada y encendida | Inicia nueva solicitud sin guardar `nueva` como servicio. | nueva conversacion o estado reiniciado, servicio vacio |
| CP-10 | Continuar solicitud anterior | Desde numero con lead previo: `continuar con la anterior` | Apagada y encendida | Reutiliza contexto previo y pide confirmacion o siguiente dato faltante. No crea lead en ese paso. | `previous_lead_id`, campos heredados, sin nuevo `lead_id` |
| CP-11 | Mensaje con adjunto y texto | Imagen con caption `Necesito estas baldosas en Santiago` | Apagada y encendida | Registra metadata del adjunto y continua flujo. No crea lead sin confirmacion. | `message_attachments`, campos detectados, sin `lead_id` |
| CP-12 | Evento no procesable | Mensaje desde grupo o mensaje propio | Apagada y encendida | Workflow ignora el evento y no crea conversacion ni lead. | sin nueva conversacion/lead, auditoria o respuesta tecnica aceptada |

## Casos AI post-integracion

| ID | Caso | Entrada | Resultado esperado | Guardrail |
| --- | --- | --- | --- | --- |
| AI-01 | AI apagada | CP-02 con `AI_LEAD_ASSISTANT_ENABLED=false` | Resultado equivalente al flujo deterministico: campos detectados y confirmacion solicitada, sin lead. | No debe existir dependencia de NVIDIA. |
| AI-02 | AI encendida con salida valida | CP-02 con AI devolviendo JSON valido, `confidence>=0.75`, campos claros y `should_create_lead=false` | El orquestador puede usar campos sugeridos y respuesta asistida; queda en confirmacion, sin crear lead. | AI no crea lead directamente. |
| AI-03 | AI invalida o falla | CP-02 con timeout, HTTP error o JSON invalido | El orquestador ignora AI, deja auditoria de falla y usa logica deterministica. | No debe bloquear la conversacion ni crear lead. |
| AI-04 | AI baja confianza | `Algo para la casa` con `confidence<0.75` | No acepta campos sugeridos por AI; pide aclaracion deterministica. | Campos no confirmados no se sobrescriben. |
| AI-05 | Correccion del usuario | En confirmacion: `No, es en Valparaiso y para instalar porcelanato` | Actualiza solo los campos corregidos explicitamente, vuelve a confirmar y no crea lead hasta nuevo `Si`. | Datos confirmados no se sobrescriben salvo correccion explicita. |

## Plan reproducible de ejecucion real

1. Ejecutar smoke local:

```bash
sh scripts/ops/test-conversation-regression-local.sh
```

2. Sincronizar workflows en preflight:

```bash
sh scripts/dev/sync-n8n-workflows.sh --preflight
```

3. Validar servicios:

```bash
sh scripts/dev/evolution-doctor.sh
docker compose --env-file .env ps
```

4. Ejecutar `CP-01` a `CP-12` con `AI_LEAD_ASSISTANT_ENABLED=false`.

5. Activar AI para pruebas controladas y resincronizar si corresponde.

6. Ejecutar `AI-01` a `AI-05` y repetir los casos criticos `CP-02`, `CP-03`, `CP-08`, `CP-11` con AI encendida.

7. Registrar evidencia en la tabla de ejecucion.

8. Si algun caso falla, capturar:

- payload entrante
- respuesta saliente
- filas relevantes de `conversations`, `messages`, `leads`, `message_attachments`
- auditorias
- execution id de n8n
- estado de feature flag AI

## Registro de ejecucion

| Fecha | ID caso | AI | Numero | conversation_id | lead_id | clickup_task_id | Vendedor | Resultado | Observaciones |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-04-26 14:11 -04 | CP-01 | N/A | 56959743973 | 8 |  |  |  | Bloqueado | El numero ya tenia leads previos 14, 15 y 16. El bot respondio flujo de contexto previo. No se creo lead nuevo; `leads` siguio en 16. |
| 2026-04-26 16:28 -04 | CP-01 | N/A | 56900002036 | 19 |  |  |  | OK | Numero limpio: `Hola` creo conversacion `waiting_user`, `current_step=city`, sin `lead_id`; pregunto ciudad. |
| 2026-04-26 16:21 -04 | CP-02 | N/A | 56900002030 | 13 |  |  |  | OK | Mensaje completo dejo `current_step=confirm` con `service=Baldosas Bano`, `city=Santiago`, `requirement=Comprar baldosas bano`; no creo lead. |
| 2026-04-26 15:09 -04 | CP-03 | N/A | 56900002027 | 10 | 22 | 86ah3ntj1 | Valentina Rojas | OK | Prueba sintetica end-to-end via webhook local. Round robin asigno vendedor notificable, creo tarea ClickUp y ejecuto notificacion. |
| 2026-04-26 16:22 -04 | CP-04 | N/A | 56900002032 | 15 |  |  |  | OK con observacion | Detecto `city=Valparaiso`, no creo lead y pregunto servicio. |
| 2026-04-26 16:22 -04 | CP-05 | N/A | 56900002031 | 14 |  |  |  | OK | Detecto `city=Santiago`, no creo lead y pregunto servicio. |
| 2026-04-26 14:18 -04 | CP-06 | N/A | 56959743973 | 8 |  |  |  | OK | `Baldosas` fue aceptado como servicio; quedo esperando requerimiento. |
| 2026-04-26 16:23 -04 | CP-07 | N/A | 56900002033 | 16 |  |  |  | OK | `Algo para la casa` no se guardo como servicio ni requerimiento; pidio ciudad. |
| 2026-04-26 16:24 -04 | CP-08 | N/A | 56900002030 | 13 |  |  |  | OK | `No, quiero corregir` reinicio conversacion a `current_step=city`, limpio estado y no creo lead. |
| 2026-04-26 14:34 -04 | CP-09 | N/A | 56959743973 | 8 |  |  |  | OK | `nueva` reinicio estado, limpio `conversations.lead_id` y no creo lead. |
| 2026-04-26 16:24 -04 | CP-10 | N/A | 56900002029 | 12 | 24 | 86ah3pba6 | Valentina Rojas | OK con observacion | `continuar con la anterior` recupero datos del lead 24 y volvio a pedir confirmacion. No creo lead nuevo en ese paso. |
| 2026-04-26 16:27 -04 | CP-11 | N/A | 56900002035 | 18 |  |  |  | OK | Imagen simulada con caption registro metadata y continuo flujo sin crear lead. |
| 2026-04-26 16:25 -04 | CP-12 | N/A | 120363000000000000 |  |  |  |  | OK | Evento de grupo fue no procesable y no creo conversacion ni lead. |
| Pendiente | AI-01 | Off |  |  |  |  |  | Pendiente | Ejecutar despues de integrar feature flag en orquestador. |
| Pendiente | AI-02 | On valida |  |  |  |  |  | Pendiente | Requiere mock local o ejecucion real controlada por integrador. |
| Pendiente | AI-03 | On invalida/falla |  |  |  |  |  | Pendiente | Debe dejar auditoria y fallback deterministico. |
| Pendiente | AI-04 | On baja confianza |  |  |  |  |  | Pendiente | Debe rechazar campos sugeridos por AI. |
| Pendiente | AI-05 | On correccion |  |  |  |  |  | Pendiente | Debe volver a confirmar antes de crear lead. |

## Correcciones historicas aplicadas durante CP-01 a CP-12

| Fecha | Hallazgo | Cambio aplicado | Estado |
| --- | --- | --- | --- |
| 2026-04-26 | Al iniciar una solicitud nueva desde una conversacion con lead previo, `conversations.lead_id` y los mensajes nuevos seguian asociados al lead anterior hasta crear el nuevo lead. | `WA - Conversation Orchestrator` ahora emite `reset_conversation_lead` cuando el usuario elige `nueva` o rechaza confirmacion, y `Persist Conversation State` limpia `conversations.lead_id`. | Aplicado y sincronizado en n8n |
| 2026-04-26 | `handed_to_sales_at` conservaba una fecha antigua cuando se reutilizaba la conversacion para una solicitud nueva. | `Persist Conversation State` ahora actualiza `handed_to_sales_at` con `NOW()` cuando el estado pasa a `handed_to_sales`, y lo limpia cuando se reinicia una solicitud. | Aplicado y sincronizado en n8n |
| 2026-04-26 | El requerimiento `Comprar para remodelar el baño` se redujo a `Comprar baldosas`, perdiendo detalle util. | La evaluacion conversacional ahora prioriza el texto real del cliente cuando responde en el paso `requirement` con una frase concreta. | Aplicado y sincronizado en n8n |
| 2026-04-26 | Desde una conversacion ya derivada, enviar `nueva` directamente no reiniciaba de inmediato; primero pedia elegir entre continuar o iniciar nueva. | `WA - Conversation Orchestrator` ahora reconoce `nueva` y `continuar` directamente cuando hay handoff previo o lead previo. | Aplicado y sincronizado en n8n |
| 2026-04-26 | `CRM - ClickUp Sync Lead` podia dejar salida final vacia cuando no habia comentario conversacional, bloqueando seller notification. | Se agrego `Return ClickUp Sync Result` y se conecto el retorno a un flujo lineal que conserva `lead_id`, `clickup_task_id` y `clickup_task_url`. | Aplicado, sincronizado y validado |
| 2026-04-26 | El round robin podia asignar vendedores activos sin `clickup_user_id`, haciendo fallar la notificacion ClickUp. | `CRM - Lead Creation And Assignment` y las queries SQL de rotacion ahora solo consideran vendedores activos con `clickup_user_id`; si no existe ninguno, la asignacion falla con `no_notifiable_seller`. | Aplicado, sincronizado y validado |
| 2026-04-26 | Los captions de imagen/documento eran extraidos por `WA - Inbound Entry`, pero `WA - Conversation Orchestrator` ignoraba texto si `message_type` no era `text`. | `Evaluate Conversation Step` ahora procesa `text_body` util aunque venga desde caption de adjunto. | Aplicado, sincronizado y validado con CP-11 |

## Resultado de cierre QA

La matriz queda lista para regresion post-AI:

- `CP-01` a `CP-12` son la base deterministica obligatoria
- `AI-01` a `AI-05` cubren feature flag, salida valida, falla/invalidez, baja confianza y correccion de usuario
- la evidencia requerida queda normalizada con `conversation_id`, `lead_id`, `clickup_task_id`, vendedor y auditorias
- existe un smoke test local versionado para proteger la matriz sin servicios reales
