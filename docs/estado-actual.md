# Estado actual — corte 2026-08-29

Este es el corte canónico del proyecto. Reemplaza a `docs/estado-actual-2026-08-08.md`,
que conservaba una fecha en el nombre por compatibilidad con enlaces existentes. Ese
documento condicionaba su propio renombre a «después de reconciliar `main`»; `main` quedó
reconciliada el 2026-08-27, de modo que el nombre estable ya no tiene bloqueo.

> **Todo el tráfico del sistema es de prueba.** No hay clientes reales. Las conversaciones
> se conducen deliberadamente para encontrar fallas del bot, así que un hallazgo operativo
> es un test que funcionó, no un incidente comercial.

## Resumen ejecutivo

| Área | Estado |
|---|---|
| Rama de entrega | `feat/afinar-hormi-atencion` |
| HEAD | `548c538`, idéntico a `origin/main` y a `main` local |
| Divergencia con `main` | 0 por delante, 0 por detrás |
| Protección de `main` | Activa, cinco checks requeridos, sin force push ni borrado |
| Pull requests | 4 mergeados en esta ventana (#3, #5, #7, #9) |
| Suite local | 214 tests en 28 archivos, base fresca |
| Paridad repositorio ↔ runtime | **OK** — verificada tras el despliegue del 29/08 |
| Entrega | Sin bloqueos de gobierno. Queda una configuración pendiente |

## Qué se entregó en esta ventana

`main` no se movía desde el `078c93e` del 2026-06-17. El diagnóstico fue que nada técnico
lo impedía: 87 commits estaban represados detrás del conflicto de **un solo archivo**, y
ese conflicto tenía una versión dos meses más vieja de un lado.

| PR | Entrega |
|---|---|
| #3 | Los 87 commits acumulados, más la protección de `main` |
| #5 | Techo de seis horas al diferido de handoff, y copia de escalación por ruta |
| #7 | La configuración decide qué áreas llegan a ClickUp; especificación actualizada |
| #9 | Gate del grafo de `connections` |

## Estado por capa

### Repositorio

- El `area === 'sales'` hard-codeado del despachador ya no existe. Un área se entrega
  cuando resuelve a al menos un asignado válido en `HANDOFF_CLICKUP_ASSIGNEES_JSON`.
  El requisito `Sales-only task destination` fue **superado** por
  `Configured-area task destination` en `openspec/specs/durable-handoff-delivery/spec.md`,
  con la razón registrada. `Safe deferral without fallback` sigue intacto y gobierna
  todos los casos no entregables.
- Un diferido tiene ventana de seis horas. Pasada, resuelve a fallo terminal no
  reintentable, con marcador `deferred_beyond_window` en la operación y en el handoff.
  Antes devolvía el intento y reprogramaba a 60 segundos, así que `max_attempts` nunca
  se alcanzaba.
- `tests/smoke/workflow-connections.test.js` valida el grafo de conexiones: terminales
  esperadas por workflow, ambas ramas de cada IF cableadas, y referencias solo a nodos
  existentes. `check:parity` nunca miró esa superficie.
- `Complete Handoff Notification` está registrado en el manifiesto de sincronización.
  Era una segunda copia mantenida a mano del archivo `.sql`, sin árbitro.
- Ramas: 10 locales, 5 en `origin`. Se podaron 22 punteros contenidos en ramas ya
  empujadas, y `origin/feature/group-notification` quedó archivada en el tag
  `archive/feature-group-notification` antes de borrarse.

### Runtime

- Desplegado el 2026-08-29 con `sync-n8n-workflows.sh --deploy`, precedido de preflight
  y snapshot en `backups/pre-deploy-20260829-105246`.
- La aceptación controlada pasó de punta a punta: lead creado con servicio
  `instalación`, ciudad `Santiago` y requerimiento `hormigón armado para losa de 100 m2`,
  más replay idempotente y sincronización a ClickUp.
- Activos: `WA - Inbound Entry`, `WA - Inbound Recovery` y los tres schedulers OPS.
- **El rollout semántico dejó de correr.** Entre el 24 y el 29 de agosto el runtime
  ejecutaba `fix/ai-prd-controlled-rollout`, una rama que no existía en ningún remoto.
  El despliegue la reemplazó por la rama de entrega. Ver la sección siguiente.

### Inventario operativo

Medido sobre `crm_whatsapp_app` el 2026-08-29:

| Métrica | Valor |
|---|---|
| Handoffs vivos | 5 `notified`, 1 `resolved`, 0 `pending` |
| Handoffs retirados | 4 (2 artefactos de prueba, 2 cerrados por área no entregable) |
| Conversaciones | 46 `handed_to_sales`, 28 `inactive_timeout`, 16 `closed`, 14 `escalation_required`, 14 `waiting_user` |
| Follow-ups | 243 `cancelled`, 73 `sent`, 23 `pending`, 5 `error` |
| `external_operations` | 62 `succeeded`, 4 `failed`, 0 `pending` |
| Salientes en `unknown` | 7 |
| Leads | 58 |

Dos notas sobre la tabla:

- Los 7 salientes en `unknown` son del 15 al 18/08 y no tienen ruta segura de retry.
  **No reejecutar, no reintentar, no usar para otra aceptación.** Se conservan como
  evidencia, igual que las operaciones 89 y 90 con marcador
  `preserved_test_artifact_closed_no_replay`.
- Los handoffs 15 y 16 se retiraron con `db/queries/ops/close-undeliverable-area-handoffs.sql`.
  Su `estado` quedó en `pending` a propósito: el esquema solo admite `pending`,
  `notified`, `acknowledged` y `resolved`, y ninguno era cierto. El `deleted_at` es lo
  que los saca de la cola, y la fila sobrevive como evidencia.

## Lo que está apagado a propósito

### Rollout semántico — `fix/ai-prd-controlled-rollout@dcbc54a`

Corrió del 24 al 29 de agosto sobre el teléfono controlado, con el comportamiento legacy
preservado para el cliente. **No se restaura por ahora**, y la razón no es desconfianza en
el contrato semántico:

```
nodos del carril shadow que persisten algo   0 de 5
registros de auditoría de evaluación shadow  0
columnas que distingan la propuesta semántica de la legacy   ninguna
```

Cinco días de corrida no dejaron una sola fila que permita comparar el camino nuevo con el
viejo. Un rollout shadow que no registra nada no puede responder la pregunta para la que
existe. Antes de volver a encenderlo hay que persistir ambas propuestas en el mismo turno,
de forma distinguible.

Conservado en cuatro lugares: `origin/fix/ai-prd-controlled-rollout`, la rama local, el
worktree `ai-controlled-rollout`, y el snapshot pre-despliegue. Se restaura con
`sync-n8n-workflows.sh --rollback backups/pre-deploy-20260829-105246`.

Quedan en el contenedor de n8n dos variables que ya nadie lee:
`AI_PRD_CONVERSATION_MODE` y `AI_PRD_CONTROLLED_PHONE_NUMBER`.

### Contrato v3 — `fix/ai-prd-v3-verification-regressions@805aba2`

Congelado. Implementación completa y verificada con PASS, pero **su carril no está
conectado a la salida conversacional**: termina en `Prepare V3 Saga Result`, un nodo de 70
caracteres sin conexión de salida, mientras toda la cadena de entrega cuelga de la rama
legacy. Pasó 13/13 tareas porque ningún gate miraba el grafo.

El detalle completo y los cinco requisitos para retomarlo están en
`openspec/changes/archive/2026-08-26-ai-prd-conversational-authority/post-archive-findings.md`.

`openspec/specs/ai-prd-conversation-control/` se mantiene **sin trackear** a propósito:
ese directorio declara la verdad vigente del sistema, y la capacidad que describe no corre.

## Pendientes

1. **Configurar el asignado de B2B.** `HANDOFF_CLICKUP_ASSIGNEES_JSON` declara `b2b`,
   `claims`, `installation` y `support` con cero asignados. Declarar un área no es
   configurarla: hasta que `b2b` resuelva a un id de usuario de ClickUp, un handoff B2B
   difiere seis horas y termina visible en vez de entregarse.
2. **U7 y U8** siguen pendientes por decisión: U7 conserva definiciones incorrectas de
   KPI-19, KPI-26 y KPI-29, y U8 no fue regenerada. **No regenerar
   `suite/report-certificacion.md`** hasta remediarlas. U4 y U9 siguen fuera de alcance.
3. **Higiene de n8n**: la base contiene `My workflow` y `test-create`, inactivos y sin
   contraparte versionada. Eliminarlos o versionarlos.
4. **Ciclo de vida del handoff**: `OPS - Handoff ClickUp Closure` existe y cierra handoffs
   desde cambios de estado en ClickUp. Verificar que el webhook llegue de verdad según
   `docs/ops/CLICKUP_WEBHOOK_TAILSCALE_FUNNEL_RUNBOOK.md`.

## Decisiones de producto vigentes

- **Una licitación deriva de inmediato al equipo**, sin capturar datos previos. La
  detección vive en la lista de keywords de `evaluate-conversation-step.js`.
- **B2B se deriva a ClickUp.** La configuración, y no un nombre en el código, decide qué
  áreas son entregables.

## Evidencia de este corte

| Verificación | Resultado |
|---|---|
| Suite completa sobre base fresca | 214 pass / 28 archivos |
| `check:parity` | 0 advertencias |
| `check:sql-references` | 0 errores, 0 advertencias |
| `shellcheck` sobre scripts modificados | 0 errores |
| Delivery Validation en los 4 PRs | 5 de 5 jobs verdes en cada uno |
| Paridad repositorio ↔ runtime | `Verificacion remota OK` |
| Aceptación controlada post-despliegue | PASS con replay idempotente |
