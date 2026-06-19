# Matriz de Pruebas Conversacionales

## Objetivo

Validar que `Hormi Atencion` funciona como asesor comercial sobre Gemini, mantiene continuidad y solo crea leads cuando existen una necesidad real, los datos criticos de la intencion y la confirmacion aplicable.

Hormi Atencion puede extraer campos, responder, pedir confirmacion y habilitar la creacion de lead cuando el usuario confirma. `n8n` y PostgreSQL siguen ejecutando el estado, la creacion del lead, ClickUp y la asignacion.

## Alcance

Incluye:

- entrada real o simulada desde WhatsApp via `Evolution API`
- procesamiento en `WA - Inbound Entry`
- orquestacion conversacional en `WA - Conversation Orchestrator`
- llamada a `AI - Lead Qualification Assistant` como ruta oficial del proyecto
- persistencia de conversacion, mensajes, auditorias y adjuntos en PostgreSQL
- creacion de lead solo con confirmacion valida
- creacion de tarea ClickUp solo para leads confirmados
- asignacion round robin y notificacion al vendedor cuando corresponda
- fallback deterministico cuando hay error de configuracion, falla del proveedor, respuesta invalida o baja confianza

No incluye:

- pruebas de carga
- multiples instancias de WhatsApp
- restore destructivo
- escritura directa del agente fuera de los workflows
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
- instancia `wahormiglass` en estado `open`, o la instancia definida en `EVOLUTION_DEFAULT_INSTANCE`
- `WA - Inbound Entry` activo en `n8n`
- vendedores reales notificables tienen `clickup_user_id`
- `AI_PROVIDER`, `AI_DIRECT_API_KEY` y `AI_DIRECT_API_MODEL` deben estar configurados segun el proveedor real para pruebas reales
- si la configuracion AI es invalida, la evidencia debe mostrar `missing_api_config` y fallback seguro

## Smoke test local sin servicios reales

El agente QA puede ejecutar esta validacion sin `.env`, proveedor AI real, PostgreSQL, ClickUp ni Evolution:

```bash
sh scripts/ops/test-conversation-regression-local.sh
```

El script valida el fixture `n8n/samples/conversation_regression_cases.sample.json` y asegura que:

- existen los casos `CP-01` a `CP-12`
- existen los casos AI `AI-01` a `AI-06`
- la evidencia obligatoria esta definida
- ningun caso permite ClickUp sin lead confirmado
- Hormi Atencion solo puede habilitar lead cuando el usuario confirma
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
- estado del proveedor AI y razon de fallback si aplica
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
SELECT entity_type, entity_id, event_name, result, created_at, metadata
FROM audit_logs
ORDER BY id DESC
LIMIT 30;
```

## Criterios generales de aprobacion

Un caso pasa si:

- el bot no entra en loop
- no repite una pregunta ya resuelta
- no crea lead sin necesidad real, datos criticos y confirmacion aplicable
- persiste conversacion y mensajes correctamente
- crea lead solo cuando corresponde
- crea tarea ClickUp solo para leads confirmados
- asigna vendedor notificable cuando el flujo espera notificacion
- deja auditoria suficiente para diagnosticar el caso
- Hormi Atencion responde como voz principal y puede habilitar un lead confirmado
- si AI falla, responde invalido o tiene baja confianza, el flujo cae a logica deterministica
- con error de configuracion AI, el flujo no se rompe: deja auditoria y cae a logica deterministica

## Casos base CP-01 a CP-12

| ID | Caso | Mensajes del cliente | Modo AI | Resultado esperado | Evidencia minima |
| --- | --- | --- | --- | --- | --- |
| CP-01 | Saludo simple | `Hola` | Real | Bot responde bienvenida y pide el primer dato faltante. No crea lead. | `conversation_id`, respuesta bot, sin `lead_id`, auditoria de decision |
| CP-02 | Mensaje completo desde el inicio | `Hola, necesito comprar baldosas en Santiago para renovar un baño` | Real | Detecta servicio, ciudad y requerimiento; pide confirmacion. No crea lead hasta confirmar. | `conversation_id`, campos detectados, `current_step=confirm`, sin `lead_id` |
| CP-03 | Confirmacion final | Despues de CP-02: `Si, correcto` | Real | Crea lead, asigna vendedor, crea tarea ClickUp y notifica si el vendedor es notificable. | `lead_id`, `clickup_task_id`, vendedor, auditorias |
| CP-04 | Respuestas fuera de orden | `Necesito instalar en Valparaiso` | Real | Aprovecha ciudad y requerimiento parcial, pregunta solo lo faltante. No crea lead antes de confirmacion. | campos detectados, pregunta siguiente, sin `lead_id` |
| CP-05 | Comprador con datos incompletos | `Quiero cotizar en Santiago` | Real | Detecta intencion y ciudad, pero pregunta producto/servicio especifico. No crea lead. | sin `lead_id`, pregunta por servicio |
| CP-06 | Respuesta directa de servicio | Despues de una pregunta por servicio: `Baldosas` | Real | Acepta `Baldosas` como servicio y avanza al siguiente dato faltante. | `service=Baldosas`, pregunta siguiente, auditoria |
| CP-07 | Requerimiento vago | `Algo para la casa` | Real | Pide aclaracion o dato mas concreto. No crea lead. AI de baja confianza no debe aceptar campos. | respuesta de aclaracion, sin `lead_id` |
| CP-08 | Rechazo en confirmacion | En confirmacion: `No, quiero corregir` | Real | Conserva el contexto, solicita el dato que desea corregir y no crea lead. Solo reinicia ante una solicitud explicita de nueva conversacion. | `qualification_context` conservado, pregunta de correccion, sin nuevo lead |
| CP-09 | Nuevo lead desde numero repetido | Desde numero con lead previo: `nueva` o `quiero hacer otra solicitud` | Real | Inicia nueva solicitud sin guardar `nueva` como servicio. | nueva conversacion o estado reiniciado, servicio vacio |
| CP-10 | Continuar solicitud anterior | Desde numero con lead previo: `continuar con la anterior` | Real | Reutiliza contexto previo y pide confirmacion o siguiente dato faltante. No crea lead en ese paso. | `previous_lead_id`, campos heredados, sin nuevo `lead_id` |
| CP-11 | Mensaje con adjunto y texto | Imagen con caption `Necesito estas baldosas en Santiago` | Real | Registra metadata del adjunto y continua flujo. No crea lead sin confirmacion. | `message_attachments`, campos detectados, sin `lead_id` |
| CP-12 | Evento no procesable | Mensaje desde grupo o mensaje propio | Real | Workflow ignora el evento y no crea conversacion ni lead. | sin nueva conversacion/lead, auditoria o respuesta tecnica aceptada |

## Casos AI post-integracion

| ID | Caso | Entrada | Resultado esperado | Guardrail |
| --- | --- | --- | --- | --- |
| AI-01 | Error de configuracion AI | CP-02 con `AI_DIRECT_API_KEY` o `AI_DIRECT_API_MODEL` pendiente | El orquestador deja auditoria `missing_api_config` y usa logica deterministica. | No debe bloquear la conversacion ni crear lead. |
| AI-02 | Hormi Atencion completa campos | CP-02 con API directa devolviendo JSON valido, `confidence>=0.75`, campos claros y `should_create_lead=false` | El orquestador puede usar campos sugeridos y respuesta asistida; queda en confirmacion, sin crear lead. | No crea lead antes de confirmacion. |
| AI-03 | AI invalida o falla | CP-02 con timeout, HTTP error o JSON invalido | El orquestador ignora AI, deja auditoria de falla y usa logica deterministica. | No debe bloquear la conversacion ni crear lead. |
| AI-04 | AI baja confianza | `Algo para la casa` con `confidence<0.75` | No acepta campos sugeridos por AI; pide aclaracion deterministica. | Campos no confirmados no se sobrescriben. |
| AI-05 | Correccion del usuario | En confirmacion: `No, es en Valparaiso y para instalar porcelanato` | Actualiza solo los campos corregidos explicitamente, vuelve a confirmar y no crea lead hasta nuevo `Si`. | Datos confirmados no se sobrescriben salvo correccion explicita. |
| AI-06 | Hormi Atencion confirma lead | En confirmacion: `Si, correcto`, con servicio, ciudad y requerimiento completos, `confirmation_status=confirmed`, `intent=confirmation_yes`, `confidence>=0.75` y `should_create_lead=true` | El orquestador acepta la decision, marca handoff listo, crea lead, sincroniza ClickUp y asigna vendedor. | Solo permitido con confirmacion explicita y campos completos. |

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

4. Ejecutar `CP-01` a `CP-12` con proveedor AI real configurado.

5. Ejecutar `AI-01` a `AI-06` y repetir los casos criticos `CP-02`, `CP-03`, `CP-08`, `CP-11`.

7. Registrar evidencia en la tabla de ejecucion.

8. Si algun caso falla, capturar:

- payload entrante
- respuesta saliente
- filas relevantes de `conversations`, `messages`, `leads`, `message_attachments`
- auditorias
- execution id de n8n
- estado del proveedor AI, modelo y razon de fallback si aplica

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
| 2026-04-26 16:24 -04 | CP-08 | N/A | 56900002030 | 13 |  |  |  | Historico | La version anterior reiniciaba el estado; el comportamiento vigente conserva contexto y pregunta que dato se debe corregir. |
| 2026-04-26 14:34 -04 | CP-09 | N/A | 56959743973 | 8 |  |  |  | OK | `nueva` reinicio estado, limpio `conversations.lead_id` y no creo lead. |
| 2026-04-26 16:24 -04 | CP-10 | N/A | 56900002029 | 12 | 24 | 86ah3pba6 | Valentina Rojas | OK con observacion | `continuar con la anterior` recupero datos del lead 24 y volvio a pedir confirmacion. No creo lead nuevo en ese paso. |
| 2026-04-26 16:27 -04 | CP-11 | N/A | 56900002035 | 18 |  |  |  | OK | Imagen simulada con caption registro metadata y continuo flujo sin crear lead. |
| 2026-04-26 16:25 -04 | CP-12 | N/A | 120363000000000000 |  |  |  |  | OK | Evento de grupo fue no procesable y no creo conversacion ni lead. |
| Pendiente | AI-01 | Config error |  |  |  |  |  | Pendiente | Debe registrar `missing_api_config` y mantener fallback seguro. |
| Pendiente | AI-02 | On valida |  |  |  |  |  | Pendiente | Requiere ejecucion real controlada por integrador. |
| Pendiente | AI-03 | On invalida/falla |  |  |  |  |  | Pendiente | Debe dejar auditoria y fallback deterministico. |
| Pendiente | AI-04 | On baja confianza |  |  |  |  |  | Pendiente | Debe rechazar campos sugeridos por AI. |
| Pendiente | AI-05 | On correccion |  |  |  |  |  | Pendiente | Debe volver a confirmar antes de crear lead. |
| Pendiente | AI-06 | On confirmada |  |  |  |  |  | Pendiente | Hormi Atencion puede habilitar lead solo con confirmacion explicita. |

## Correcciones historicas aplicadas durante CP-01 a CP-12

| Fecha | Hallazgo | Cambio aplicado | Estado |
| --- | --- | --- | --- |
| 2026-04-26 | Al iniciar una solicitud nueva desde una conversacion con lead previo, `conversations.lead_id` y los mensajes nuevos seguian asociados al lead anterior hasta crear el nuevo lead. | `WA - Conversation Orchestrator` ahora emite `reset_conversation_lead` cuando el usuario elige `nueva` o rechaza confirmacion, y `Persist Conversation State` limpia `conversations.lead_id`. | Aplicado y sincronizado en n8n |
| 2026-04-26 | `handed_to_sales_at` conservaba una fecha antigua cuando se reutilizaba la conversacion para una solicitud nueva. | `Persist Conversation State` ahora actualiza `handed_to_sales_at` con `NOW()` cuando el estado pasa a `handed_to_sales`, y lo limpia cuando se reinicia una solicitud. | Aplicado y sincronizado en n8n |
| 2026-04-26 | El requerimiento `Comprar para remodelar el baño` se redujo a `Comprar baldosas`, perdiendo detalle util. | La evaluacion conversacional ahora prioriza el texto real del cliente cuando responde en el paso `requirement` con una frase concreta. | Aplicado y sincronizado en n8n |
| 2026-04-26 | Desde una conversacion ya derivada, enviar `nueva` directamente no reiniciaba de inmediato; primero pedia elegir entre continuar o iniciar nueva. | `WA - Conversation Orchestrator` ahora reconoce `nueva` y `continuar` directamente cuando hay handoff previo o lead previo. | Aplicado y sincronizado en n8n |
| 2026-06-18 | Respuestas breves como `no` podian interpretarse como rechazo global y borrar contexto. | Se agregaron `qualification_context` y `pending_question_key`; `si/no` se aplica ahora a la pregunta vigente y solo una solicitud explicita reinicia. | Aplicado, sincronizado y validado E2E |
| 2026-04-26 | `CRM - ClickUp Sync Lead` podia dejar salida final vacia cuando no habia comentario conversacional, bloqueando seller notification. | Se agrego `Return ClickUp Sync Result` y se conecto el retorno a un flujo lineal que conserva `lead_id`, `clickup_task_id` y `clickup_task_url`. | Aplicado, sincronizado y validado |
| 2026-04-26 | El round robin podia asignar vendedores activos sin `clickup_user_id`, haciendo fallar la notificacion ClickUp. | `CRM - Lead Creation And Assignment` y las queries SQL de rotacion ahora solo consideran vendedores activos con `clickup_user_id`; si no existe ninguno, la asignacion falla con `no_notifiable_seller`. | Aplicado, sincronizado y validado |
| 2026-04-26 | Los captions de imagen/documento eran extraidos por `WA - Inbound Entry`, pero `WA - Conversation Orchestrator` ignoraba texto si `message_type` no era `text`. | `Evaluate Conversation Step` ahora procesa `text_body` util aunque venga desde caption de adjunto. | Aplicado, sincronizado y validado con CP-11 |

## Resultado de cierre QA

La matriz queda lista para regresion post-AI:

- `CP-01` a `CP-12` son la base deterministica obligatoria
- `AI-01` a `AI-06` cubren error de configuracion, salida valida, falla/invalidez, baja confianza, correccion de usuario y creacion confirmada
- la evidencia requerida queda normalizada con `conversation_id`, `lead_id`, `clickup_task_id`, vendedor y auditorias
- existe un smoke test local versionado para proteger la matriz sin servicios reales

## Criterios de calidad del asesor comercial

Cada respuesta generada por AI debe cumplir:

- reconoce la informacion nueva del cliente antes de avanzar
- aporta orientacion comercial o explica brevemente por que solicita el siguiente dato
- contiene como maximo una pregunta principal
- usa lenguaje profesional, cercano, chileno y consultivo
- evita entusiasmo generico, respuestas de catalogo y listas de preguntas
- no repite datos presentes en `qualification_context`
- interpreta `si/no` segun `pending_question_key`
- conserva el contexto salvo que el cliente pida explicitamente iniciar una solicitud nueva
- no anuncia derivacion antes de que exista `lead_id`
- deja un siguiente paso claro y coherente con D.A.T.O.S.

Casos adicionales obligatorios:

| ID | Caso | Resultado esperado |
| --- | --- | --- |
| QA-01 | `no` ante retiro de escombros | Guarda `debris_removal=false`, conserva producto/comuna/medidas y avanza. |
| QA-02 | `no` ante `anything_else` | Cierra cordialmente sin borrar ni reabrir la solicitud. |
| QA-03 | rechazo de confirmacion final | Conserva contexto y pregunta que dato desea corregir. |
| QA-04 | instalacion en Vitacura | Orienta sobre el resultado buscado y pregunta un dato por turno. |
| QA-05 | handoff confirmado | El mensaje de derivacion solo se envia despues de crear y asignar el lead. |
