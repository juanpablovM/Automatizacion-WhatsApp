# Estado actual — corte actualizado 2026-08-22

Este es el corte canónico del proyecto. El trabajo está publicado en
`feat/afinar-hormi-atencion` hasta `a3fc789`, sincronizado con su remoto y verificado contra
el runtime. No existe pull request y `main` no está protegida: la rama acumula 79 commits sin
integrar. La remediación P2, P3 y P4 está desplegada y aceptada; el repositorio y el runtime
ya representan el mismo estado.

> El nombre de este archivo conserva la fecha `2026-08-08` por compatibilidad con los enlaces
> existentes en `README.md`, `docs/guia-produccion.md`, `docs/handoff-actual.md` y
> `docs/matriz-cumplimiento-prd.md`. Adoptar un nombre estable sin fecha queda pendiente hasta
> después de reconciliar `main`, para no ampliar el conflicto abierto en `README.md`.

## Resumen ejecutivo

| Área | Estado |
|---|---|
| Rama | `feat/afinar-hormi-atencion` |
| HEAD publicado | `a3fc789` |
| Divergencia remota | Rama local y `origin/feat/afinar-hormi-atencion` en `a3fc789` |
| Divergencia con `main` | 79 commits por delante, 1 por detrás |
| Publicación | Rama publicada; no existe PR; `main` sin protección |
| Integración continua | Run 32585056879 verde en los 5 jobs |
| Paridad repositorio ↔ runtime | 14 de 14 definiciones coinciden por hash |
| Unidades remediadas | U1, U3, U5 y U6 |
| Candidato de repositorio | `complete-durable-handoff-delivery` archivado; 10/10 requisitos y 10/10 escenarios PASS |
| Pendientes por decisión | U4, U7, U8 y U9 |
| Entrega | Bloqueada por gobierno, no por defectos: falta la cadena de PRs y la protección de `main` |

## Estado por capa

### Repositorio

- **U1:** corregida la continuidad conversacional y la conservación del contexto válido.
- **U3:** el candidato final implementa entrega durable Sales-only de notificaciones ClickUp, con claim, estados terminales y reconciliación segura.
- El marcador de identidad contractual es exactamente `Operation key: {operation_key}`; la clave estable conserva la forma `handoff-clickup:{handoff_id}`.
- Un estado ambiguo se reconcilia primero mediante GET paginado sobre tareas activas/cerradas y archivadas. Un POST posterior sólo puede ocurrir ante cero coincidencias y con una autorización de no-efecto coincidente ya consumida.
- Las áreas distintas de `sales`, incluso si tienen un mapeo configurado, se difieren sin construir payload ni ejecutar POST a ClickUp.
- **U5:** implementada la descarga segura de media mediante Evolution API, persistencia real y recuperación durable.
- **U6:** implementado el scheduler de follow-up con opt-out durable y manejo seguro de resultados ambiguos.
- El SDD `complete-durable-handoff-delivery` está archivado en `openspec/changes/archive/2026-08-17-complete-durable-handoff-delivery/`; su especificación quedó sincronizada en `openspec/specs/durable-handoff-delivery/spec.md`.
- **U4, U7, U8 y U9:** permanecen fuera del cambio actual por decisión.
- **U7:** siguen abiertos los errores de definición de KPI-19, KPI-26 y KPI-29.
- El cambio OpenSpec `ai-prd-conversational-authority` figura activo con sus tareas sin reconciliar, y el worktree `Automatizacion-WhatsApp-worktrees/ai-prd-contract` sigue en `32c1de7`. Integrar o descartar ese trabajo es una decisión abierta.

### Runtime

- Las migraciones `015`, `016` y `017` están aplicadas en `crm_whatsapp_app`.
- `WA - Inbound Entry`, `WA - Inbound Recovery` y los tres schedulers OPS están activos. El resto de los workflows versionados son sub-workflows `executeWorkflowTrigger` y no requieren activación propia.
- Evolution apunta al POST canónico `.../evolutionwebhook/wa-inbound-entry`; n8n registra ese POST y el GET de healthcheck.
- **Paridad verificada el 2026-08-22: 14 OK, 0 DRIFT, 0 MISSING.** El drift del `WA - Conversation Orchestrator` descrito en cortes anteriores fue resuelto; la definición viva quedó actualizada el `2026-08-22 12:04:57-04`.
- El guardrail contra promesas falsas de derivación está activo en el código desplegado, verificado ejecutando el `jsCode` vivo del nodo `Apply AI Assistance` sobre cuatro casos: bloquea `«voy a derivar»` y `«he derivado»` convirtiéndolos en `prd_validated_fallback`, no altera una respuesta ordinaria y no interfiere con un handoff genuino.
- La aceptación controlada del 2026-08-22 se ejecutó con snapshot previo en `backups/20260822-131448` y no produjo lead, handoff ni tarea ClickUp espuria. En la ventana de prueba n8n registró 124 ejecuciones `success`, 0 `error` y 0 inbound `failed`.

La reparación del baseline del `2026-08-08` se hizo desde un snapshot completo en `backups/runtime-repair-20260808-192944/`, sin enviar mensajes E2E ni crear efectos externos.

### Inventario operativo pendiente

Medido el 2026-08-22 sobre `crm_whatsapp_app`:

| Métrica | Valor |
|---|---|
| Handoffs registrados / con `resolved_at` | 6 (4 vigentes) / 0 |
| Conversaciones abiertas en `escalation_required` | 7 |
| Follow-ups `cancelled` / `sent` / `pending` / `error` | 171 / 16 / 13 / 5 |
| Mensajes salientes con `delivery_status = 'unknown'` | 7 |
| Mensajes salientes con `reconciliation_required = true` | 0 |
| `external_operations` en `unknown` / `failed` / `succeeded` | 0 / 2 / 50 |

Dos observaciones sobre esta tabla:

- Que ningún handoff tenga `resolved_at` **no es una falla**. `db/queries/n8n/handoff-routing/04_advance_handoff_state.sql` es la única sentencia capaz de escribirlo y ningún workflow la referencia: el ciclo de vida más allá de `notified` no está cableado. Decidir entre cablearlo desde un evento confiable o declarar `notified` terminal y retirar el SQL muerto es la tarea P5 del plan de remediación.
- **Hay dos inventarios distintos y conviene no confundirlos.** En `external_operations` la cuarentena está resuelta: 0 registros en `unknown`, 50 `succeeded` y 2 `failed` —los ids 89 y 90, `handoff_clickup_notification`, marcados `preserved_test_artifact_closed_no_replay` y conservados como evidencia. En `messages`, en cambio, hay 7 salientes con `delivery_status = 'unknown'` y **ninguno** marcado con `reconciliation_required`: la marca de cuarentena no está aplicada en esa columna, de modo que esos mensajes no están protegidos por un indicador propio. Siguen sin ruta segura de retry: **no deben reejecutarse (`replay`), reintentarse ni usarse para otra aceptación**.

### Higiene del runtime

La base de n8n contiene 16 workflows, contra 14 versionados en `n8n/workflows/`. Los dos
sobrantes son `My workflow` y `test-create`, ambos inactivos y sin contraparte en el
repositorio. No están cubiertos por la verificación de paridad y conviene eliminarlos o
versionarlos explícitamente.

### Certificación

La verificación del cambio `complete-durable-handoff-delivery` está en PASS con 10/10 requisitos, 10/10 escenarios, cero bloqueantes y cero hallazgos críticos. Esto certifica el candidato de repositorio, no el cierre completo del PRD.

La certificación general del PRD **no es válida como cierre**: U7 conserva definiciones de KPI incorrectas y U8 no fue regenerada.

No se debe regenerar `suite/report-certificacion.md` hasta remediar U7 y U8.

## Evidencia local reciente

| Verificación | Resultado |
|---|---|
| CI, run 32585056879 sobre `a3fc789` | 5 de 5 jobs verdes |
| Paridad repositorio ↔ runtime | 14/14 definiciones PASS |
| Guardrail de derivación sobre el código desplegado | 4/4 casos conformes |
| SDD durable handoff | 10/10 requisitos y 10/10 escenarios PASS |
| Contrato AI | 9 escenarios PASS |
| Regresión conversacional | 33 casos PASS |
| Harnesses handoff/operaciones/dispatcher | PASS |
| Checks estáticos, sincronización de nodos, JSON y shell | PASS |
| Gate U1 previo | 126 PASS / 0 FAIL |
| U2 — ciclo de oportunidad | 20 PASS / 0 FAIL |
| U5 — media | PASS |
| U6 — follow-up | PASS |
| Bootstrap y contratos de subworkflow | PASS |
| Webhooks Entry | POST canónico + GET healthcheck PASS |

## Próximo corte

- Cerrar la colisión de puertos entre `docker-compose.yml` y `docker-compose.test.yml`: ambos publican 5433 y 5678 en el host.
- Incorporar el commit que falta de `origin/main`, resolver el conflicto de `README.md` y repetir la suite completa.
- Abrir la cadena de pull requests encabezada por un issue aprobado, y activar la protección de `main` con los cinco checks como requeridos.
- Decidir el ciclo de vida del handoff (P5) antes de construir cualquier automatización sobre él.
- Adoptar un nombre estable para este corte canónico, una vez reconciliado `README.md`.
- Decidir el destino del worktree `ai-prd-contract` y reconciliar sus tareas OpenSpec.
- Eliminar o versionar los dos workflows huérfanos de la base de n8n.
- Mantener U7 y U8 pendientes hasta retomarlas explícitamente; mantener U4 y U9 fuera de alcance.
- No reusar, reejecutar (`replay`) ni reintentar los outbounds en `unknown`; conservarlos como evidencia persistente.
- Ejecutar cualquier aceptación externa sólo con autorización independiente y el teléfono de prueba controlado.
- Mantener evidencia separada de repositorio, runtime y efectos externos.
