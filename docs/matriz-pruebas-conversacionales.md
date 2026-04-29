# Matriz de Pruebas Conversacionales

## Objetivo

Validar que el flujo conversacional actual funciona con casos variados antes de avanzar a seguridad, backup/restore o `AI - Lead Qualification Assistant`.

Esta matriz busca detectar bugs criticos restantes sin seguir perfeccionando indefinidamente la logica deterministica. Si un caso falla, se registra evidencia y se corrige antes de pasar a la siguiente fase.

## Alcance

Incluye:

- entrada real o simulada desde WhatsApp via `Evolution API`
- procesamiento en `WA - Inbound Entry`
- estado conversacional en PostgreSQL
- respuesta saliente por `WA - Outbound Messages`
- creacion de lead cuando corresponde
- creacion de tarea ClickUp solo cuando hay confirmacion valida
- asignacion round robin
- notificacion al vendedor cuando existe tarea ClickUp

No incluye todavia:

- pruebas de carga
- multiples instancias de WhatsApp
- AI
- backup/restore
- seguridad del webhook

## Preparacion

Antes de ejecutar:

```bash
sh scripts/dev/evolution-doctor.sh
sh scripts/dev/sync-n8n-workflows.sh --preflight
docker compose --env-file .env ps
```

Verificar:

- `n8n` corriendo
- `postgres` healthy
- `redis` healthy
- `evolution-api` corriendo
- instancia `principal` en estado `open`
- `WA - Inbound Entry` activo en `n8n`

## Evidencia a registrar

Para cada caso, registrar:

- fecha y hora
- numero usado
- mensajes enviados por el cliente
- respuestas del bot
- `conversation_id`
- `lead_id`, si se crea
- `clickup_task_id`, si se crea
- vendedor asignado, si aplica
- resultado: `OK`, `Falla` o `Bloqueado`
- observaciones

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

## Criterios generales de aprobacion

Un caso pasa si:

- el bot no entra en loop
- no repite una pregunta ya resuelta
- no crea lead sin `servicio + ciudad + requerimiento + confirmacion`
- persiste conversacion y mensajes correctamente
- crea lead solo cuando corresponde
- crea tarea ClickUp solo para leads confirmados
- deja auditoria suficiente para diagnosticar el caso

## Casos de prueba

| ID | Caso | Mensajes del cliente | Resultado esperado | Evidencia | Estado |
| --- | --- | --- | --- | --- | --- |
| CP-01 | Saludo simple | `Hola` | Bot responde bienvenida y pide el primer dato faltante. No crea lead. | `conversation_id`, respuesta bot, sin `lead_id` | OK |
| CP-02 | Mensaje completo desde el inicio | `Hola, necesito comprar baldosas en Santiago para renovar un baño` | Bot detecta servicio, ciudad y requerimiento; pide confirmacion. No crea lead hasta confirmar. | `conversation_id`, campos detectados, `current_step=confirm` | OK |
| CP-03 | Confirmacion final | Despues de CP-02: `Si, correcto` | Bot deriva a ventas, crea lead, asigna vendedor, crea tarea ClickUp y notifica. | `lead_id`, `clickup_task_id`, vendedor, auditorias | OK |
| CP-04 | Respuestas fuera de orden | `Necesito instalar en Valparaiso` -> responder servicio si falta | Bot aprovecha ciudad y requerimiento parcial, pregunta solo lo faltante. No crea lead antes de confirmacion. | campos detectados, pregunta siguiente | OK con observacion |
| CP-05 | Comprador con datos incompletos | `Quiero cotizar en Santiago` | Bot detecta intencion y ciudad, pero pregunta producto/servicio especifico. No crea lead. | sin `lead_id`, pregunta por servicio | OK |
| CP-06 | Respuesta directa de servicio | Despues de una pregunta por servicio: `Baldosas` | Bot acepta `Baldosas` como servicio y avanza al siguiente dato faltante. | `service=Baldosas`, pregunta siguiente | OK |
| CP-07 | Requerimiento vago | `Algo para la casa` | Bot pide aclaracion o dato mas concreto. No crea lead. | respuesta de aclaracion, sin `lead_id` | OK |
| CP-08 | Rechazo en confirmacion | En confirmacion: `No, quiero corregir` | Bot reinicia o solicita correccion sin crear lead. | `current_step` vuelve a dato inicial o correccion, sin nuevo lead | OK |
| CP-09 | Nuevo lead desde numero repetido | Desde numero con lead previo: `nueva` o `quiero hacer otra solicitud` | Bot inicia nueva solicitud sin guardar `nueva` como servicio. | nueva conversacion o estado reiniciado, servicio vacio | OK |
| CP-10 | Continuar solicitud anterior | Desde numero con lead previo: `continuar con la anterior` | Bot reutiliza contexto previo y pide confirmacion o siguiente dato faltante. | `previous_lead_id`, campos heredados | OK con observacion |
| CP-11 | Mensaje con adjunto y texto | Enviar imagen con caption `Necesito estas baldosas en Santiago` | Bot registra metadata del adjunto y continua flujo. No crea lead sin confirmacion. | `message_attachments`, campos detectados | OK |
| CP-12 | Evento no procesable | Mensaje desde grupo o mensaje propio | Workflow ignora el evento y no crea conversacion ni lead. | sin nueva conversacion/lead | OK |

## Registro de ejecucion

| Fecha | ID caso | Numero | conversation_id | lead_id | clickup_task_id | Vendedor | Resultado | Observaciones |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-04-26 14:11 -04 | CP-01 | 56959743973 | 8 |  |  |  | Bloqueado | El numero ya tenia leads previos 14, 15 y 16. El bot respondio flujo de contexto previo: "Ya tengo una solicitud anterior asociada a este numero. ¿Quieres continuar con esa solicitud o iniciar una nueva?". No se creo lead nuevo; `leads` sigue en 16. |
| 2026-04-26 16:28 -04 | CP-01 | 56900002036 | 19 |  |  |  | OK | Numero limpio: `Hola` creo conversacion `waiting_user`, `current_step=city`, sin `lead_id`; respondio bienvenida y pregunto `¿Desde qué ciudad nos escribes?`. La entrega saliente fallo por numero sintetico, pero el texto quedo persistido. |
| 2026-04-26 16:21 -04 | CP-02 | 56900002030 | 13 |  |  |  | OK | Mensaje completo desde el inicio dejo `current_step=confirm` con `service=Baldosas Bano`, `city=Santiago`, `requirement=Comprar baldosas bano`; no creo lead. La salida a WhatsApp fallo por numero sintetico, pero el texto de confirmacion se persistio correctamente. |
| 2026-04-26 14:20 -04 | CP-03 | 56959743973 | 8 | 17 | 86ah3nfn1 | Valentina Rojas | OK parcial | Confirmacion `Si` creo lead 17 con `previous_lead_id=16`, servicio `Baldosas`, ciudad `Santiago`, requerimiento `Comprar baldosas`; creo tarea ClickUp `https://app.clickup.com/t/86ah3nfn1` y asigno vendedor por round robin. No hubo auditoria `seller_notification_dispatch` para lead 17 y el estado quedo `created_in_clickup`, no `notified`, porque los vendedores no tienen `clickup_user_id`. Observaciones adicionales: `handed_to_sales_at` conserva fecha antigua de la conversacion reutilizada y los mensajes previos a la creacion del lead quedaron con `lead_id=16`. |
| 2026-04-26 14:36 -04 | CP-03 | 56959743973 | 8 | 18 | 86ah3nj3y | Martina Perez | OK parcial | Reprueba despues de correcciones: confirmacion `Si` creo lead 18 con `previous_lead_id=17`, servicio `Baldosas`, ciudad `Santiago`, requerimiento `Instalar baldosas`; creo tarea ClickUp `https://app.clickup.com/t/86ah3nj3y`, asigno vendedor por round robin y dejo `handed_to_sales_at=2026-04-26 14:36:24 -04`. Los mensajes de la nueva solicitud previa a crear lead quedaron sin `lead_id`, como se esperaba. Sigue sin notificacion al vendedor porque los vendedores no tienen `clickup_user_id`. |
| 2026-04-26 15:00 -04 | CP-03 | 56959743973 | 8 | 20 | 86ah3nq8a | Valentina Rojas | OK | Confirmacion `Si` creo lead 20 con servicio `Unas Baldosas`, ciudad `Santiago`, requerimiento `Necesito comprar unas baldosas`, tarea ClickUp `https://app.clickup.com/t/86ah3nq8a` y vendedor con `clickup_user_id=89137576`. La notificacion no salio en la primera ejecucion por salida vacia de `CRM - ClickUp Sync Lead`; despues de corregir el retorno, se recupero el lead 20 con `seller_notification_dispatch` audit id 194 y estado `notified`. |
| 2026-04-26 15:09 -04 | CP-03 | 56900002027 | 10 | 22 | 86ah3ntj1 | Valentina Rojas | OK | Prueba sintetica end-to-end via webhook local. El round robin salto vendedores sin `clickup_user_id`, asigno a Valentina, creo tarea ClickUp y ejecuto `CRM - Seller Notification Dispatch` con audit id 193. El lead quedo en estado `notified`. |
| 2026-04-26 16:19 -04 | CP-03 | 56900002029 | 12 | 24 | 86ah3pba6 | Valentina Rojas | OK | Prueba sintetica end-to-end con comentario conversacional completo. `CRM - ClickUp Sync Lead` recupero 771 caracteres de conversacion, creo comentario `Conversación Completa Cliente` con id `90130257660080`, devolvio `conversation_comment_status=created`, y luego ejecuto `seller_notification_dispatch` con audit id 218. |
| 2026-04-26 16:22 -04 | CP-04 | 56900002032 | 15 |  |  |  | OK con observacion | `Necesito instalar en Valparaiso` detecto `city=Valparaiso`, no creo lead y pregunto `¿Qué servicio estás buscando?`. Observacion: `instalar` se usa como intencion, pero no se conserva como requerimiento parcial sin servicio. |
| 2026-04-26 16:22 -04 | CP-05 | 56900002031 | 14 |  |  |  | OK | `Quiero cotizar en Santiago` detecto `city=Santiago`, no creo lead y pregunto por servicio. |
| 2026-04-26 14:18 -04 | CP-06 | 56959743973 | 8 |  |  |  | OK | Tras pregunta por servicio, `Baldosas` fue aceptado como `service=Baldosas`; `city=Santiago`, `requirement=null`, `current_step=requirement`. El bot pregunto `Cuéntame brevemente qué necesitas resolver, instalar, reparar o comprar.` No se creo lead nuevo (`leads` sigue en 16). |
| 2026-04-26 16:23 -04 | CP-07 | 56900002033 | 16 |  |  |  | OK | `Algo para la casa` no se guardo como servicio ni requerimiento, no creo lead y pidio ciudad con pregunta especifica. |
| 2026-04-26 16:24 -04 | CP-08 | 56900002030 | 13 |  |  |  | OK | En confirmacion, `No, quiero corregir` reinicio la conversacion a `current_step=city`, limpio estado y no creo lead. |
| 2026-04-26 14:13 -04 | CP-09 | 56959743973 | 8 |  |  |  | OK con observacion | Al enviar `nueva`, el bot respondio `¿Desde qué ciudad nos escribes?`; no creo lead nuevo (`leads` sigue en 16), `current_step=city`, auditoria `after_payload` dejo `service`, `city` y `requirement` en `null`. Observacion: `conversations.lead_id` y mensajes nuevos siguen asociados al lead previo 16, revisar si debe limpiarse al iniciar una solicitud nueva. |
| 2026-04-26 14:34 -04 | CP-09 | 56959743973 | 8 |  |  |  | OK | Reprueba despues de correccion: al enviar `nueva`, el bot respondio `¿Desde qué ciudad nos escribes?`; `current_step=city`, `conversations.lead_id=NULL`, `handed_to_sales_at=NULL`, mensajes 109 y 110 quedaron sin `lead_id`, auditoria registra `reset_conversation_lead=true`. No se creo lead nuevo (`leads` sigue en 17). |
| 2026-04-26 16:24 -04 | CP-10 | 56900002029 | 12 | 24 | 86ah3pba6 | Valentina Rojas | OK con observacion | `continuar con la anterior` recupero los datos del lead 24 y volvio a pedir confirmacion. No creo lead nuevo en ese paso. Observacion: `handed_to_sales_at` conserva la fecha del handoff previo mientras el estado vuelve a `waiting_user`. |
| 2026-04-26 16:27 -04 | CP-11 | 56900002035 | 18 |  |  |  | OK | Imagen simulada con caption `Necesito estas baldosas en Santiago` registro `message_type=image` y metadata en `message_attachments` (`image/jpeg`, `baldosas-cp11.jpg`, media id `test-media-key-cp11-2`). Despues de corregir lectura de captions, detecto `service=Estas Baldosas`, `city=Santiago`, quedo en `current_step=requirement` y no creo lead. |
| 2026-04-26 16:25 -04 | CP-12 | 120363000000000000 |  |  |  |  | OK | Evento de grupo `120363000000000000@g.us` respondio `accepted`, pero `Normalize Evolution Payload` lo marco como no procesable. Conteo de conversaciones para ese telefono se mantuvo en 0 antes y despues. |

## Correcciones aplicadas durante la ejecucion

| Fecha | Hallazgo | Cambio aplicado | Estado |
| --- | --- | --- | --- |
| 2026-04-26 | Al iniciar una solicitud nueva desde una conversacion con lead previo, `conversations.lead_id` y los mensajes nuevos seguian asociados al lead anterior hasta crear el nuevo lead. | `WA - Conversation Orchestrator` ahora emite `reset_conversation_lead` cuando el usuario elige `nueva` o rechaza confirmacion, y `Persist Conversation State` limpia `conversations.lead_id`. | Aplicado y sincronizado en n8n |
| 2026-04-26 | `handed_to_sales_at` conservaba una fecha antigua cuando se reutilizaba la conversacion para una solicitud nueva. | `Persist Conversation State` ahora actualiza `handed_to_sales_at` con `NOW()` cuando el estado pasa a `handed_to_sales`, y lo limpia cuando se reinicia una solicitud. | Aplicado y sincronizado en n8n |
| 2026-04-26 | El requerimiento `Comprar para remodelar el baño` se redujo a `Comprar baldosas`, perdiendo detalle util. | La evaluacion conversacional ahora prioriza el texto real del cliente cuando responde en el paso `requirement` con una frase concreta. | Aplicado y sincronizado en n8n |
| 2026-04-26 | Desde una conversacion ya derivada, enviar `nueva` directamente no reiniciaba de inmediato; primero pedia elegir entre continuar o iniciar nueva. | `WA - Conversation Orchestrator` ahora reconoce `nueva` y `continuar` directamente cuando hay handoff previo o lead previo. | Aplicado y sincronizado en n8n |
| 2026-04-26 | `CRM - ClickUp Sync Lead` creaba tarea ClickUp, pero la salida final podia quedar vacia cuando no habia comentario conversacional; por eso `WA - Inbound Entry` no ejecutaba `CRM - Seller Notification Dispatch`. | Se agrego `Return ClickUp Sync Result` y se conecto el retorno a un flujo lineal que conserva `lead_id`, `clickup_task_id` y `clickup_task_url`, aun cuando el comentario se salte o falle. | Aplicado, sincronizado y validado |
| 2026-04-26 | Para probar notificacion interna se requiere `clickup_user_id` en el vendedor asignado. | Se cargo temporalmente `clickup_user_id=89137576` en el proximo vendedor de la rotacion (`Valentina Rojas`) para ejecutar una prueba real de notificacion. | Dato de prueba activo |
| 2026-04-26 | El round robin podia asignar vendedores activos sin `clickup_user_id`, lo que hacia fallar la notificacion ClickUp. | `CRM - Lead Creation And Assignment` y las queries SQL de rotacion ahora solo consideran vendedores activos con `clickup_user_id`; si no existe ninguno, la asignacion falla con `no_notifiable_seller`. | Aplicado, sincronizado y validado con lead 22 |
| 2026-04-26 | El comentario conversacional completo habia quedado desconectado para no romper la salida de `CRM - ClickUp Sync Lead`; ademas la consulta original solo miraba `messages.lead_id`, que quedaba vacio para mensajes previos a la creacion del lead. | `Load ClickUp Context` ahora arma la conversacion desde la conversacion asociada al lead y la acota desde el lead anterior; `Create Conversation Comment If Present` crea el comentario usando `helpers.httpRequest` y conserva siempre el payload de retorno. | Aplicado, sincronizado y validado con lead 24 |
| 2026-04-26 | Los captions de imagen/documento eran extraidos por `WA - Inbound Entry`, pero `WA - Conversation Orchestrator` ignoraba cualquier texto si `message_type` no era `text`. | `Evaluate Conversation Step` ahora procesa `text_body` util aunque venga desde caption de adjunto. | Aplicado, sincronizado y validado con CP-11 |

## Resultado de cierre

La matriz queda cerrada para esta fase:

- todos los casos criticos `CP-01` a `CP-10` estan en `OK` o `OK con observacion`
- los casos con adjuntos/no procesables tienen comportamiento conocido
- los errores encontrados tienen evidencia y correccion documentada
- `docs/handoff-actual.md` ya refleja el nuevo estado

El siguiente paso recomendado es seguridad y recuperacion minima:

1. proteccion del webhook
2. backup de PostgreSQL
3. backup del volumen de `n8n`
4. prueba controlada de `OPS - Error Handler`
