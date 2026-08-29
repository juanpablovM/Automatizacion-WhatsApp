# Matriz de Cumplimiento del PRD — Línea Base y Trazabilidad (Unidad 0)

> **Baseline histórico de U0.** Los estados y totales de esta matriz representan el relevamiento del `2026-08-07`; no describen las remediaciones posteriores ni el runtime vigente. Consultar el [estado actual del proyecto](./estado-actual.md) antes de tomar decisiones de implementación o certificación.

## 1. Propósito

Este documento es el artefacto de la **Unidad 0** del plan de cierre de brechas del proyecto
CRM WhatsApp Automatizado (Hormiglass). Establece la línea base de cumplimiento entre el
documento normativo `docs/prd-agente-whatsapp-hormiglass.md` (PRD v1.0) y la implementación
actual versionada en el repositorio: workflows n8n, consultas SQL, migraciones, seeds y
harnesses de prueba.

La Unidad 0 NO modifica código, workflows, SQL ni runtime. Es un registro de trazabilidad
(criterios, casos, implementación, pruebas y evidencia esperada) y deja documentadas las
**brechas** que alimentarán la priorización de las Unidades 1-9.

## 2. Metadatos de la línea base

| Atributo | Valor |
|---|---|
| Fecha | 2026-08-07 |
| Rama | `feat/afinar-hormi-atencion` |
| HEAD | `87b28b6947e684d03bd58a7363a04a5cb4915de0` |
| Working tree | `docs/prd-agente-whatsapp-hormiglass.md` **modificado sin commit** (279 líneas añadidas, 15 eliminadas respecto de HEAD) |
| Contenedores activos | `crm-whatsapp-automatizado-n8n` (5678), `-evolution-api` (8080), `-postgres` (5433→5432, healthy), `-redis` (healthy) |
| Stack | n8n 1.123.29, PostgreSQL 16.13 (`crm_whatsapp_app`), Evolution API v2.3.7, Redis 7.4, NVIDIA AI (`meta/llama-3.1-8b-instruct`) |

> Nota: la rama es la fuente normativa vigente, pero el PRD contiene cambios en el working
> tree. Esta matriz se construyó contra la versión **de trabajo** del PRD (la única vigente al
> relevamiento) y cita su seccionado; si esos cambios no se commitean, la numeración aquí
> referida podría quedar fuera de sincronía. Riesgo registrado en la Sección 10.

## 3. Método y verificación de las IDs

El PRD **no enumera explícitamente** sus criterios con IDs estables. Esta unidad deriva la
numeración estable respetando la fuente normativa:

| Conjunto | Origen en PRD | Derivación | Total |
|---|---|---|---|
| Criterios de aceptación `CR-001..CR-020` | Sección **33 «Criterios de aceptación»** | La sección lista exactamente 20 ítems numerados 1..20. `CR-nnn` = ítem `nnn`. Mapeo 1:1 sin reordenamiento | 20 |
| Casos normativos `CS-001..CS-008` | Sección **31 «Evaluación del agente»** | La sección lista exactamente 8 escenarios de evaluación numerados 1..8. `CS-nnn` = ítem `nnn` | 8 |

Evidencia del conteo, verificada línea a línea en el PRD:
- `#33` contiene los ítems desde «Responde de forma clara y profesional» hasta «Mejora la
  calidad de las conversaciones comerciales» (exactamente 20).
- `#31` contiene los escenarios desde «Cuanto sale el metro de cierre» hasta «Solo quiero
  saber si tienen stock» (exactamente 8).

No existen otras secciones de aceptación ni de evaluación en el PRD que compitan con estas.

## 4. Leyenda de estados

| Marca | Significado |
|---|---|
| **Requisito PRD** | Sección/ítem del PRD que exige el comportamiento |
| **Implementación (IMP)** | `SI` / `PARCIAL` / `NO` en el repositorio |
| **Prueba existente (TST)** | Ruta del harness y qué cubre; `NO` si no hay cobertura |
| **Evidencia runtime** | Objeto observable por SQL/API en PostgreSQL, n8n, ClickUp o Evolution |
| **Trazabilidad** | `Cubierto` = implementación + prueba + evidencia; `Parcial` = implementación confirmada pero con prueba o ruta incompleta; `Pendiente` = sin implementación identificada |

Convención de archivos citados (rutas relativas a la raíz del repo):

| Archivo | Rol |
|---|---|
| `n8n/workflows/wa-inbound-entry.json` | Webhook Evolution → inbox durable + claim |
| `n8n/workflows/wa-conversation-orchestrator.json` | Máquina de pasos conversacional + voz AI |
| `n8n/workflows/ai-lead-qualification-assistant.json` | Clasificador/calificador AI (contrato, retries, fallback) |
| `n8n/workflows/wa-inbound-downstream-dispatcher.json` | Dispatcher post-turno (respuesta, lead, ClickUp, notificación) |
| `n8n/workflows/crm-lead-creation-and-assignment.json` | Creación de lead + rotación round-robin |
| `n8n/workflows/crm-clickup-sync-lead.json` | Sincronización con ClickUp (tarea, custom fields, comment) |
| `n8n/workflows/crm-seller-notification-dispatch.json` | Notificación al vendedor asignado |
| `n8n/workflows/wa-outbound-messages.json` | Envío vía Evolution API con claim e idempotencia |
| `n8n/workflows/wa-inbound-recovery.json` | Recovery FIFO de eventos inbound por scheduler |
| `n8n/workflows/ops-error-handler.json` | Auditoría de errores (`workflow_execution_error`) |

---

## 5. Criterios de aceptación del PRD (CR-001..CR-020)

### CR-001 — Responde de forma clara y profesional

| Campo | Contenido |
|---|---|
| Requisito PRD | `#33.1`; base en `#7` (personalidad) y `#24` (mensajes base) |
| Implementación | `wa-conversation-orchestrator.json`: nodo `Evaluate Conversation Step` (preguntas en español cercano, p. ej. `baseQuestions.city`/`service`) y `Apply AI Assistance` (voz AI como prioridad `PRIORITY 3`); envío por `wa-outbound-messages.json` nodo `Build Outbound Payload` |
| IMP | SI |
| Prueba | `scripts/ops/test-conversation-regression-local.sh` (casos `CP-01..CP-12`) y `scripts/ops/test-advisor-vitacura-e2e.sh` (E2E real en WhatsApp) |
| Evidencia runtime | `messages.direction='outgoing'` con el texto del asistente; `audit_logs.metadata_json.response_kind`; `delivery_status` en `sent/failed/unknown` |
| Trazabilidad | **Cubierto** |

### CR-002 — No inventa precios ni stock

| Campo | Contenido |
|---|---|
| Requisito PRD | `#14` (precios), `#15` (stock), `#29` (guardrails), `#33.2` |
| Implementación | `wa-conversation-orchestrator.json` nodo `Apply AI Assistance` — bloque `PRD_VALIDATORS` (declarado fuente de verdad de las reglas PRD): `NO_INVENT_PRICE` (exige `hasAuthorizedPriceContext`) y `NO_CONFIRM_STOCK`, con textos de fallback literales del PRD; contexto de precios provisto por `ai-lead-qualification-assistant.json` nodo `Load Commercial Context` (query `db/queries/n8n/ai-sales-advisor/01_load_commercial_context.sql`: catálogo + `price_rules` activas) |
| IMP | SI |
| Prueba | `scripts/ops/test-conversation-regression-local.sh` (casos `inventedPrice` e `inventedStock` → `response_kind='prd_validated_fallback'` con texto seguro del PRD); `scripts/ops/test-ai-assistant-local.sh` (contrato de `price_context`) |
| Evidencia runtime | `advisor_decisions.metadata_json.prd_rule_violated` = `NO_INVENT_PRICE`/`NO_CONFIRM_STOCK`; respuesta al cliente con el fallback literal del PRD |
| Trazabilidad | **Cubierto** |

### CR-003 — No vea pagos

| Campo | Contenido |
|---|---|
| Requisito PRD | `#16`, `#33.3` |
| Implementación | `Apply AI Assistance` — `PRD_VALIDATORS.NO_CONFIRM_PAYMENT` (bloquea "pago confirmado / transferencia recibida / ya puedes retirar / ya está validado") con el mensaje obligatorio de Finanzas del PRD |
| IMP | SI |
| Prueba | Solo de forma indirecta a través del harness de guardrails de `test-conversation-regression-local.sh`; **no existe un caso directo de pago** en el fixture (brecha B13) |
| Evidencia runtime | `advisor_decisions.metadata_json.prd_rule_violated='NO_CONFIRM_PAYMENT'`; `response_kind='prd_validated_fallback'` + texto «La validación final del pago la realiza Finanzas» |
| Trazabilidad | **Parcial** (falta caso de prueba directo de pago) |

### CR-004 — Detecta la intención del cliente

| Campo | Contenido |
|---|---|
| Requisito PRD | `#9.2`, `#12` (25 intenciones), `#33.4` |
| Implementación | `Evaluate Conversation Step` — capa determinista con `intentKeywords`, `detectActionIntent`, `greetingOnly`; y `ai-lead-qualification-assistant.json` (`Build AI Request`) con el campo `intent` como requerido en el schema de salida |
| IMP | SI |
| Prueba | `test-ai-assistant-local.sh` (assert sobre `schema.required` incl. `intent`); `test-conversation-regression-local.sh` (CP-02, CP-06: mensajes con acción) |
| Evidencia runtime | `audit_logs.metadata_json.ai_intent` / `advisor_decisions.intent`; `conversations.current_step` |
| Trazabilidad | **Cubierto** |

### CR-005 — Levanta datos mínimos

| Campo | Contenido |
|---|---|
| Requisito PRD | `#9.3`, `#13`, `#33.5` |
| Implementación | Máquina de pasos: `baseQuestions` (city / service / requirement) en `Evaluate Conversation Step`; preguntas factibles por campo (`measurements`, `quantity`, `address`, etc.) en `Apply AI Assistance`; gate real en `crm-lead-creation-and-assignment.json` nodo `Prepare Lead Qualification` — exige 3 campos completos (`completedFieldsCount<3` lanza error «faltan servicio, ciudad o requerimiento») |
| IMP | SI |
| Prueba | `test-conversation-regression-local.sh`: CP-05 (datos incompletos) + fixture `lead_creation_gate` = [servicio, ciudad, requerimiento, confirmación]; `test-e2e-lead-creation.sh` |
| Evidencia runtime | `leads.service/city/requirement`; `leads.lead_status_id` = `qualified_complete`; `conversations.qualification_context` poblado; auditoría de rechazo por el gate |
| Trazabilidad | **Cubierto** |

### CR-006 — Usa el diagnóstico D.A.T.O.S.

| Campo | Contenido |
|---|---|
| Requisito PRD | `#10`, `#33.6` |
| Implementación | `ai-lead-qualification-assistant.json` (`Build AI Request`): el schema requiere `diagnostic_datos` y el prompt incluye literalmente "D.A.T.O.S." y "Clasifica el lead"; `Apply AI Assistance` persiste `qualification_context.diagnostic_datos` (pain, scope, timing, obstacle, next_step) en `advisor_decisions` |
| IMP | SI (estructura). La **calidad** de la extracción queda en el LLM (no determinista) |
| Prueba | `scripts/ops/test-ai-assistant-local.sh` (verifica prompt D.A.T.O.S. y schema); **no** hay evaluación automática del % de conversaciones con diagnóstico completo |
| Evidencia runtime | `advisor_decisions.input_payload.diagnostic_datos`; métricas `#32.4` no computadas (brecha B09) |
| Trazabilidad | **Parcial** |

### CR-007 — Clasifica Leads A/B/C/D

| Campo | Contenido |
|---|---|
| Requisito PRD | `#9.4`, `#11`, `#33.7` |
| Implementación | `ai-lead-qualification-assistant.json` (prompt "Clasifica el lead" + `lead_class` requerido en schema); `Apply AI Assistance` lo persiste en `qualification_context.lead_class`. La clasificación **no modifica el routing**: `wa-inbound-downstream-dispatcher.json` solo filtra `should_create_lead`; no hay acción diferencial por clase A/B/C/D |
| IMP | SI (detecta y registra); **Parcial** para el efecto de `#11`/`#23` |
| Prueba | Contrato en `test-ai-assistant-local.sh`; sin prueba de efectos de prioridad |
| Evidencia runtime | `conversations.qualification_context.lead_class` / `advisor_decisions.lead_class` |
| Trazabilidad | **Parcial** |

### CR-008 — Detecta B2B

| Campo | Contenido |
|---|---|
| Requisito PRD | `#19`, `#11.4`, `#33.8` |
| Implementación | Deterministas `b2bKeywords` (constructora, inmobiliaria, OC, licitación, factura, …) en `Evaluate Conversation Step` con `b2b_redirect` al confirmar; señal AI `customer_type='b2b'` / `lead_class='D'`, pregunta empresa / contacto / cantidad / OC (`advisorQuestion`) |
| IMP | SI para detección + recolección; **la derivación a área B2B / Patricia no existe**: el lead va al mismo lane de `crm-seller-notification-dispatch` sin diferenciar canal B2B |
| Prueba | Sin caso dedicado en el fixture (brecha B04) |
| Evidencia runtime | `qualification_context.customer_type='b2b'` / `lead_class='D'`; `response_kind='b2b_redirect'`; `leads.assigned_seller_id` = vendedor por rotación común |
| Trazabilidad | **Parcial** |

### CR-009 — Detecta instalación

| Campo | Contenido |
|---|---|
| Requisito PRD | `#17`, `#33.9` |
| Implementación | `knownServices` incluye `instalacion` en la capa determinista; `modality='installation'`; ramal `advisorQuestion` con measurements / terrain / truck_access / desired_date; regla `NO_PROMISE_INSTALLATION` con el texto del PRD |
| IMP | Sí |
| Prueba | **Sin caso dedicado** de escenario de instalación en el harness local (brecha B13) |
| Evidencia runtime | `qualification_context.modality='installation'` + ramal de preguntas; `response_kind='advisor_guardrail_question'` |
| Trazabilidad | **Parcial** (test dedicado ausente) |

### CR-010 — Pregunta por retiro de escombros cuando corresponde

| Campo | Contenido |
|---|---|
| Requisito PRD | `#18`, `#33.10` |
| Implementación | En `Apply AI Assistance`, con `modality==='installation'` y `debris_removal` sin definir, `requiredQuestionKey` fuerza la pregunta `debris_removal` ("La instalación requiere retirar escombros o material anterior?"); la respuesta sí/no persiste `qualification_context.debris_removal` vía `pendingBooleanField` |
| IMP | Sí |
| Prueba | Sin caso directo de escombros en el harness local (brecha B13) |
| Evidencia runtime | `qualification_context.debris_removal` = sí/no + pregunta en `messages.direction='outgoing'` |
| Trazabilidad | **Cubierto** (implementación completa) / **Parcial** (sin caso de prueba) |

### CR-011 — Maneja objeciones sin bajar el precio automáticamente

| Campo | Contenido |
|---|---|
| Requisito PRD | `#20`, `#21`, `#33.11` |
| Implementación | `PRD_VALIDATORS.NO_DISCOUNT` (bloquea ofrecer descuento); detección `objection_detected` (schema AI); contexto de playbooks de objeción inyectado a la AI desde `db/queries/n8n/ai-sales-advisor/01_load_commercial_context.sql` (`objection_playbooks`); respuesta AI como voz principal (`objection_response`) |
| IMP | Sí (mecanismo); los textos fijos de `#21.1..21.5` no son plantillas por objeción — quedan en el LLM |
| Prueba | Sin caso dedicado de objeción en el harness |
| Evidencia runtime | `advisor_decisions.objection_detected`; `response_kind='objection_response'` |
| Trazabilidad | **Parcial** |

### CR-012 — Deriva a humano cuando corresponde

| Campo | Contenido |
|---|---|
| Requisito PRD | `#22`, `#23`, `#33.12` |
| Implementación | `Evaluate Conversation Step`: detección `wantsHuman`, frustración y bucle de confirmación (>2) → `escalation_required`; escalación operativa de AI (`escalation_area`). El handoff verificado está en `wa-inbound-downstream-dispatcher.json`: nodos `Prepare Verified Handoff`, `Handoff Items?`, `Execute Handoff Outbound` |
| IMP | Sí (wantsHuman, escalación por área, handoff verificado) |
| Límite | Los triggers de `#22` (reclamo, garantía, factura, despacho, pago…) **no están codificados uno a uno**: la escalada depende de la semántica de la AI |
| Prueba | `test-dispatcher-runtime-integrity-local.sh` (3 contratos del handoff), `test-conversation-regression-local.sh` (CONV-FLOW-V2-01/02/07, escalaciones), `test-e2e-lead-creation.sh` |
| Trazabilidad | **Parcial** |

### CR-013 — Registra datos en CRM / ClickUp

| Campo | Contenido |
|---|---|
| Requisito PRD | `#25`, `#28.1`, `#33.13` |
| Implementación | `crm-lead-creation-and-assignment.json` (crea/upserts lead + rotación); `crm-clickup-sync-lead.json` (crea la tarea, custom fields, `Persist ClickUp Result`, comment resumen, ledger `external_operations`); `crm-seller-notification-dispatch.json` notifica al vendedor asignado solo tras `clickup_task_id` válido |
| IMP | Sí |
| Pruebas | `test-e2e-lead-creation.sh` (AI+lead+asignación+ClickUp+handoff+replay idempotente); `test-clickup-ambiguity-local.sh` (5xx/timeout → `unknown` sin POST, 429 retry, tarea `unknown` nunca reejecuta); `test-secondary-effects-local.sh` (queries de `external_operations` y rotación) |
| Evidencia | `leads.clickup_task_id`/`click_up_url` y `lead_status='created_in_clickup'`; `external_operations.status` (succeeded/unknown/failed); `audit_logs.event_name='clickup_task_sync'` |
| Trazabilidad | **Cubierto** |

### CR-014 — Adjunta archivos o fotos a la oportunidad

| Campo | Contenido |
|---|---|
| Requisito PRD | `#25.2`, `#28.1`, `#33.14` |
| Implementación | El media inbound se persiste en `message_attachments` (query `01_upsert_attachment_metadata.sql` de `wa-conversation-orchestrator`) y `attachments_json` viaja en el payload de `crm-clickup-sync-lead` (nodo `Build ClickUp Payload`); el resumen y conversación se envían como comentario |
| IMP | **PARCIAL** — NO existe subida real del media al task de ClickUp (sí los comentarios/custom fields); la propia `docs/matriz-pruebas-conversacionales.md` declara "adjuntos ClickUp como funcionalidad nueva" (fuera de alcance) |
| Prueba | Sin harness de adjuntos ClickUp |
| Evidencia | `message_attachments` (metadatos) + `attachments_json` en el payload; sin `Task Attachment` en ClickUp |
| Trazabilidad | **Parcial** |

### CR-015 — Crea un resumen útil para la ejecutiva

| Campo | Contenido |
|---|---|
| Requisito PRD | `#34`, `#33.15` |
| Implementación | `Apply AI Assistance` fabrica `executive_summary` multicampo (cliente, tipo, clasificación, producto, modalidad, comuna, cantidad/medidas, urgencia, terreno, acceso, escombros, fotos, necesidad, objeción); `crm-clickup-sync-lead` lo publica como comentario "Resumen Comercial AI" + conversación completa |
| IMP | Sí |
| Prueba | `test-ai-assistant-local.sh` (schema requiere `executive_summary`); E2E valida el comentario |
| Evidencia | ClickUp `Task Comment`; `advisor_decisions.executive_summary` |
| Trazabilidad | **Cubierto** |

### CR-016 — No cierra reclamos sin derivación

| Campo | Contenido |
|---|---|
| Requisito PRD | `#22`, `#33.16` |
| Implementación | No se implementa un flujo dedicado de reclamo (los campos de `#13.6` no se recolectan de forma determinística); los reclamos se escalan vía `escalation_area='claims'` (AI) con `conversation_status_code='escalation_required'`; no se cierra el lead |
| IMP | **Parcial** (escalatoria por IA, sin tipificación explícita ni recolección de número de venta / producto / fecha / fotos) |
| Prueba | No |
| Trazabilidad | **Parcial** |

### CR-017 — No cuenta plazos no validados

| Campo | Contenido |
|---|---|
| Requisito PRD | `#21.4`, `#33.17` |
| Implementación | `PRD_VALIDATORS.NO_PROMISE_DELIVERY` y `NO_PROMISE_INSTALLATION` (textos "revisar / confirmar antes de prometer") |
| IMP | Sí |
| Prueba | Cubierto indirectamente vía `prd_validated_fallback` en `test-conversation-regression-local.sh`; sin caso dedicado de plazo |
| Trazabilidad | **Cubierto** (mecanismo) / **Parcial** (caso dedicado) |

### CR-018 — Deja claro el siguiente paso

| Campo | Contenido |
|---|---|
| Requisito PRD | `#30`, `#33.18` |
| Implementación | `next_best_action` (AI); `advisorQuestion` por campo pendiente; mensajes de handoff / `Build Quotation` ("Te derivaré con una ejecutiva… preparar la cotización"); `conversations.pending_question_key` queda poblado en turnos no terminales |
| IMP | Sí |
| Evidencia | `advisor_decisions.next_best_action`; `conversations.pending_question_key` no nulo en turnos no cerrados |
| Trazabilidad | **Cubierto** |

### CR-019 — Alimenta métricas

| Campo | Contenido |
|---|---|
| Requisito PRD | `#32`, `#28.6` |
| Implementación | Persistencia de datos crudos (conversations, messages, leads, audit_logs, advisor_decisions, inbound_events); tabla `monitor_snapshots` (migración `009`) existe pero está vacía; existe query de monitoreo `db/queries/ops/monitor-active-conversations.sql`; **no hay cálculo** de las métricas de `#32` ni dashboard (`#28.6`) |
| IMP | **PARCIAL** |
| Trazabilidad | **Parcial** |

### CR-020 — Mejora la calidad de las conversaciones comerciales

| Campo | Contenido |
|---|---|
| Requisito PRD | `#3`, `#33.20` |
| Implementación | Criterio longitudinal de propósito general; no posee métrica de "calidad comercial" definida ni línea base de evaluación |
| IMP | **Pendiente** |
| Trazabilidad | **Pendiente** |

---

## 6. Casos normativos de evaluación (CS-001..CS-008, PRD `#31`)

> Los escenarios derivados de `#31` **no están reproducidos palabra por palabra** en el
> fixture `n8n/samples/conversation_regression_cases.sample.json` (contiene 12 casos base
> `CP` y 6 casos AI). La cobertura de cada CS es, por tanto, indirecta: responde a los
> guardrails y al flujo conversacional existente, no a un caso de prueba literal con el
> texto exacto del PRD. Esta es la brecha B13.

### CS-001 — «¿Cuánto sale el metro de cierre?» (`#31.1`)

- **Implementación**: no hay precio directo sin contexto oficial (`NO_INVENT_PRICE`) y se
  pregunta comuna / metros / modalidad / uso / fecha (flujo `base city/service/requirement`).
- **Prueba**: cubierta por `inventedPrice` en `test-conversation-regression-local.sh`
  (misma semántica, sin el texto literal).
- **Trazabilidad**: **Cubierto** (guardrail) / **Parcial** (caso literal).

### CS-002 — «En otro lado me sale más barato» (`#31.2`)

- **Implementación**: `NO_DISCOUNT` (no baja el precio automáticamente) + `objection_detected`
  con playbooks de `01_load_commercial_context.sql`; narrativa de costo-total por el LLM.
- **Prueba**: no hay caso literal ni caso dedicado de objeción.
- **Trazabilidad**: **Parcial**.

### CS-003 — «Soy de una constructora, necesito cotizar 500 m» (`#31.3`)

- **Implementación**: `b2bKeywords` (constructora / OC / licitación) → `b2b_redirect` +
  `advisorQuestion` (empresa, RUT, obra, comuna, producto, cantidad, plazo, OC).
- **Prueba**: **sin caso en el fixture** (brecha B04).
- **Trazabilidad**: **Parcial**.

### CS-004 — «Te mandé el comprobante, ¿cuál despachan?» (`#31.4`)

- **Implementación**: `NO_CONFIRM_PAYMENT` bloquea confirmar y responde "la validación la
  realiza Finanzas"; la recepción del comprobante depende de la escalada de la AI.
- **Prueba**: sin caso literal de pago-comprobante (brecha B02).
- **Trazabilidad**: **Parcial**.

### CS-005 — «Quiero instalar pastelones en mi patio» (`#31.5`)

- **Implementación**: ramal de instalación (comuna, medidas, fotos, terreno, acceso,
  fecha y retiro de escombros) vía `advisorQuestion` con `modality='installation'`.
- **Prueba**: sin caso literal.
- **Trazabilidad**: **Cubierto** (flujo) / **Parcial** (prueba).

### CS-006 — «Necesito factura» (`#31.6`)

- **Implementación**: `invoice_required` en `allowedQualificationKeys` y escalatoria de AI a
  finance/administración; no existe un flujo determinístico de facturación ni derivación fija.
- **Prueba**: sin caso.
- **Trazabilidad**: **Parcial**.

### CS-007 — «Quiero reclamar por la instalación» (`#31.7`)

- El PRD exige datos básicos + fotos y derivación urgente a humano.
- **Implementación**: **NO identificada** como flujo dedicado; `escalation_area='claims'`
  depende exclusivamente de la AI; sin recolección explícita de los campos de reclamo.
- **Trazabilidad**: **Pendiente** (brecha fuerte B01).

### CS-008 — «¿Tienen stock?» (`#31.8`)

- **Implementación**: `NO_CONFIRM_STOCK` (sin integración real) con el texto literal del PRD;
  intent `stock_inquiry` redirige pidiendo producto + validación por el equipo.
- **Prueba**: `inventedStock` en `test-conversation-regression-local.sh` (assert de
  `response_kind='prd_validated_fallback'` y copy del PRD).
- **Trazabilidad**: **Cubierto**.

---

## 7. Brechas de trazabilidad (alimentar de priorización de Unidades 1-9)

| # | Requisito PRD | Brecha | Evidencia en repo | Impacto |
|---|---|---|---|---|
| B01 | `#13.4` reclamo (CS-007) | Sin flujo de reclamo: no recolecta datos mínimos (venta / fecha / producto / fotos) ni deriva urgente determinística | Solo `escalation_area='claims'` (AI); sin nodo/query dedicado | Reclamos no quedan estructurados |
| B02 | `#13.8` comprobante (CS-004) | No hay flujo real de recepción de comprobante → Finanzas; los campos `payment_*` existen en contexto pero no se derivan | Keys `payment_amount/payment_method` en `allowedQualificationKeys`; sin nodo de derivación a Finanzas | Comprobantes 100% dependientes de la escalada de IA |
| B03 | `#9.4`, `#11`, `#23` priorización | `lead_class` (A/B/C/D) se persiste pero NO altera routing, prioridad ni rotación | Dispatcher filtra solo `should_create_lead`; rotación round-robin ignora la clase | §23 sin aplicación |
| B04 | `#19`/B2B (CS-003) | Derivación a «Patricia / área B2B» no existe; el vendedor notificado es el de la rotación común | `seller-notification-dispatch` es lane único | B2B se trata como lead común |
| B05 | `#22` triggers de escalamiento | Los triggers de escalado (garantía, factura, despacho comprometido, etc.) no están determinizables; dependen de la semántica de IA | `Evaluate Step` solo codifica `wantsHuman`/frustración | Escaladas sin respaldo por reglas |
| B06 | `#13.2/` B2B, `#13.5` retiro | Campos dedicados (B2B, despacho, retiro) se recogen en `allowedQualificationKeys` pero sin validación de completitud por caso de uso | `allowedKeys` amplia; gate de lead solo exige 3 campos base | Datos B2B/despacho incompletos |
| B07 | `#21.1-21.5` objeciones | Los textos de objeción no son plantillas fijas; se dejan al LLM (solo `objection_detected` + playbooks) | `PRD_VALIDATORS` no contiene plantillas de `#21` | Trazabilidad de copy frágil |
| B08 | `#28.1`/CR-014 | Subida real de media/fotos al task de ClickUp NO implementada (solo metadata) | `message_attachments`; `attachments_json`; sin `Task Attachment` | CR-014 parcial |
| B09 | `#32`, `#28.6` | Datos crudos y `monitor_snapshots` vacía; sin cómputo de métricas ni dashboard | `009` y `monitor-active-conversations.sql` | No se mide |
| B10 | `#24.10` fuera de horario | No se implementa respuesta «fuera de horario de atención» | No encontrado en flujos | Falta de canal horario |
| B11 | `#13.7` garantía | No se recolecta la información de garantía ni se deriva a postventa+instalación | No encontrado | Garantía sin flujo |
| B12 | `#16` comprobante (texto) | El texto de `#16` puede aparecer solo vía fallback del guard; no hay manejo operativo del comprobante como evento | No hay nodo específico | Cumplimiento deficiente |
| B13 | `#31` casos de evaluación (CS) | Los 8 escenarios de `#31` no tienen casos de prueba literales (solo CP genéricos) | fixture `conversation_regression_cases.sample.json` | Trazabilidad CS incompleta |
| B14 | `#34` resumen | El resumen de ejecutivo depende del LLM; si `ai_skipped`, no hay resumen determinístico | `Apply AI Assistance`, `executive_summary` | Fallback sin resumen |
| B15 | `#11.4` condiciones especiales | No hay flag persistido `requiere_aprobacion_management` en `leads`/ClickUp (solo `escalation_area='management'` en escalafón de AI) | — | Condición B2B especial sin bandera |

**Total de brechas registradas: 15 (B01-B15).** No se resuelven aquí; serán priorizadas en las Unidades 1-9.

---

## 8. Comandos de prueba y estado de la suite

| Nivel | Comando | Qué valida |
|---|---|---|
| Local (harness node, sin servicios externos) | `sh scripts/ops/test-ai-assistant-local.sh` | Contrato AI (schema: D.A.T.O.S., lead_class, confirmation, executive_summary, restrictive config; retries; fallback) |
| Local (harness node) | `sh scripts/ops/test-conversation-regression-local.sh` | Casos CP-01..12, AI-01..06, CONV-FLOW-V2 (guardrails, escalaciones, regresión, memoria) |
| Con PostgreSQL (DB temporal) | `sh scripts/ops/test-delivery-integrity-local.sh` | Migraciones 001-007, `claim_inbound_event`, atribución legacy, reaplicación idempotente |
| Con PostgreSQL (DB temporal) | `sh scripts/ops/test-historical-repair-local.sh` | Reparación de estado conversacional (`legacy_conversations_state`, stale rows) |
| Harness node | `sh scripts/ops/test-clickup-ambiguity-local.sh` | 5xx/timeout → `unknown` (un solo POST), 429 → retry, op `unknown` nunca reejecuta, comentario 503 |
| Harness node | `sh scripts/ops/test-secondary-effects-local.sh` | Queries de lead/notificación: lock `external_operations`, bloqueo de `unknown` y retry-safe |
| Node + archivos | `sh scripts/ops/test-dispatcher-runtime-integrity-local.sh all` | Integridad semántica del dispatcher (3 contratos) + verificación de enlaces/`versionId` |
| Almacenamiento | `sh scripts/ops/backup-local.sh` + `sh scripts/ops/verify-backup-local.sh` | Backup y verificación de restore de dumps |
| E2E con efectos externos (opt-in, tel. controlado) | `E2E_ALLOW_EXTERNAL_EFFECTS=yes sh scripts/ops/test-e2e-lead-creation.sh <teléfono>` | AI + lead + asignación + ClickUp + handoff + replay idempotente |
| E2E webhook local | `sh scripts/ops/test-error-handler.sh <teléfono>` / `sh scripts/ops/test-advisor-vitacura-e2e.sh` | Auditoría de error (`workflow_execution_error`) y flujo conversacional E2E |

Verificación previa: `docker compose --env-file .env ps`, `sh scripts/dev/evolution-doctor.sh`,
`sh scripts/dev/sync-n8n-workflows.sh --preflight`.

> **Estado de la suite al baseline**: los harness de `scripts/ops` documentados en
> `docs/operacion-local.md` quedaron en estado OK en el escenario anterior al HEAD relevado
> (según git log y documentación). En la Unidad 0 **no se vuelven a ejecutar** para no
> provocar mutación runtime no solicitada; los contenedores relevados estaban up (healthy).

---

## 9. Resumen de cubrimiento

| Conjunto | Total | Cubierto | Parcial | Pendiente |
|---|---|---|---|---|
| Criterios de aceptación (`CR-001..CR-020`) | 20 | 9 | 10 | 1 |
| Casos normativos (`CS-001..CS-008`) | 8 | 2 | 5 | 1 |
| **Total** | **28** | **11** | **15** | **2** |

- Criterios `Cubierto`: CR-01, 02, 04, 05, 10 (impl.), 13, 15, 17 (impl.), 18.
- Casos `Cubierto`: CS-001 (guardrail), CS-008.
- Pendientes: CR-020 (métrica de calidad) y CS-007 (flujo de reclamo).
- Áreas de mayor riesgo operativo: comprobantes y reclamos (B01, B02, B12), priorización
  (B03), B2B (B04) y métricas/dashboard (B09) — corresponden a fases 2-4 del PRD aún
  incompletas.

**Automatizaciones (PRD `#27`)**: A-001 oportunidad temprana (U2, `01_upsert_early_opportunity.sql`, test-opportunity-cycle-local.sh); A-002/A-003/A-004 campos de producto/comuna/instalación (U1, gate comercial); A-005/A-006 clasificación B2B/Lead A (textos en fixtures, handoff/prioridad); A-007 derivación urgente (U3); A-008 comprobante → Finanzas (U3 routing `HANDOFF_ROUTING.payment_proof`); A-009 fotos (U5: `media_attachments`, adjunto ClickUp diferido por decisión de usuario); **A-010 seguimiento 0/1/3/7/14 (U6):** tabla `follow_ups`, scheduler `OPS - Follow-Up Scheduler` con claim `FOR UPDATE SKIP LOCKED`, cancelación por respuesta/derivación/pérdida, `opt_out` definitivo, ventana horaria 09-20 y textos por step/motivo en fixture — validado con `test-followup-cadence-local.sh` (17+32 asserts deterministas).

**Evidencia certificable de la Unidad 0**: ninguna exigencia del PRD queda sin un **ID
estable**. Las 28 entidades (20 `CR` + 8 `CS`) cubren literalmente las secciones de
verificación `#33` y `#31`. Para cada una queda registrada la implementación `repo:nodo`,
la prueba (o su ausencia) y la evidencia runtime esperada, lo que habilita la priorización
de las Unidades 1-9.

---

## 10. Riesgos para las siguientes unidades

1. **PRD modificado sin commit**: la matriz se construyó contra el working tree. Si el PRD
   se revierte fuera de la línea, la correspondencia CR/CS puede desincronizarse. Se
   recomienda para la Unidad 1 decidir si se commitea o se congela el snapshot SHA.
2. **Reglas de negocio en JS del workflow**: `PRD_VALIDATORS` y sus fallbacks viven en el
   nodo `Apply AI Assistance` (código de workflow), no en un recurso único. Una edición del PRD puede
   romper el texto literal de los fallbacks. Evaluar extraerlas a un recurso versionado.
3. **Dependencia fuerte del LLM** para: clasificación A/B/C/D, `objection_detected`,
   `escalation_area`, `confirmation_status`, `executive_summary` y extracción D.A.T.O.S. Las
   heurísticas deterministas solo cubren `wantsHuman`, keywords B2B y guardrails de texto.
4. **Guardia `confidence >= 0.75`**: `aiCanCreateLead` exige confianza + 3 campos +
   `confirmation_yes`; si el modelo degrada su confianza se pierden leads que sí eran
   calificados (observable vía `ai_creation_blocked_by_orchestrator`).
5. **Evolution sin idempotencia de endpoint** (comentado en `wa-outbound-messages`): un retry
   puede duplicar el mensaje; mitigado con `maxAttempts=1` + reconciliación operativa.
6. **ClickUp**: la forma de `reconciliation_required`/`unknown` requiere marcación manual; la
   derivación B2B/Patricia y la bandera `requiere_aprobacion_management` no existen en la
   estructura del lead (B04, B15).
7. **Rotación**: round-robin no pondera el `lead_type`/prioridad (§23) — brecha B03.
8. **Fixtures**: los 8 casos de `#31` no están en la suite como casos literales; su cobertura
   depende de casos genéricos, difícil de traducir a delivery (B13).

---

## 11. Anexo — Mapa del flujo de implementación actual

```
Evolution webhook → WA Inbound Entry (normalize + claim `claim_inbound_event`)
  → WA Conversation Orchestrator (paso deterministico + AI `ai-lead-qualification`)
  → persiste conversación (estado, auditoría, adjuntos)
  → WA Inbound Downstream Dispatcher
       ├─ responde (WA Outbound Messages → Evolution, claim + idempotencia)
       ├─ crea lead (CRM Lead Creation + rotación round-robin)
       │    └─ ClickUp Sync (task, custom fields, comment, ledger `external_operations`)
       │         └─ CRM Seller Notification
       └─ handoff verificado (mensaje de cierre al cliente)
  → WA Inbound Recovery (scheduler, reproceso FIFO de eventos pendientes)
  → OPS Error Handler (audita `workflow_execution_error`)
```

Fuentes estructurales de evidencia (SQL): migraciones `infra/postgres/migrations/001..009`,
`db/queries/n8n/{workflow}/{00}_*.sql`, `db/seeds/001..010` y docs de apoyo
`docs/handoff-actual.md`, `docs/matriz-pruebas-conversacionales.md`,
`docs/operacion-local.md`.
