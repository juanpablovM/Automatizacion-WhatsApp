# Estado actual — corte actualizado 2026-08-17

Este es el corte canónico del proyecto. El candidato final de entrega durable está verificado y archivado, pero todavía no fue revisado para entrega, confirmado en un commit ni desplegado. El runtime y el repositorio no representan el mismo estado.

## Resumen ejecutivo

| Área | Estado |
|---|---|
| Rama | `feat/afinar-hormi-atencion` |
| HEAD | `791f9f3` |
| Divergencia remota | 1 commit ahead de `origin/feat/afinar-hormi-atencion` |
| Working tree | Candidato final, archivo SDD y documentación sin commit |
| Unidades remediadas | U1, U3, U5 y U6 |
| Candidato de repositorio | `complete-durable-handoff-delivery` archivado; 10/10 requisitos y 10/10 escenarios PASS |
| Runtime observado | Baseline anterior y un despliegue previo del scheduler; la corrección final no está desplegada |
| Pendientes por decisión | U4, U7, U8 y U9 |
| Entrega | Pendiente de revisión del diff, commit y despliegue controlado del scheduler |

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

### Runtime

- Las migraciones `015`, `016` y `017` están aplicadas en `crm_whatsapp_app`.
- `WA - Inbound Entry`, `WA - Inbound Recovery` y los tres schedulers OPS están activos.
- Evolution apunta al POST canónico `.../evolutionwebhook/wa-inbound-entry`; n8n registra ese POST y el GET de healthcheck.
- El último corte remoto completo validado antes de este candidato reportó 14/14 definiciones coincidentes.
- Durante la implementación hubo un despliegue autorizado, acotado al scheduler, y una aceptación controlada. La corrección final posterior —Sales-only, marcador exacto y reconciliación GET-first autorizada— no se desplegó.
- El outbound generado por esa aceptación recibió HTTP 500 del proveedor y permanece `unknown/reconciliation_required`. Su entrega es indeterminada: **no debe reejecutarse (`replay`), reintentarse ni usarse para otra aceptación**. Debe conservarse para reconciliación operativa.

La reparación del baseline del `2026-08-08` se hizo desde un snapshot completo en `backups/runtime-repair-20260808-192944/`, sin enviar mensajes E2E ni crear efectos externos.

### Certificación

La verificación del cambio `complete-durable-handoff-delivery` está en PASS con 10/10 requisitos, 10/10 escenarios, cero bloqueantes y cero hallazgos críticos. Esto certifica el candidato de repositorio, no el runtime desplegado ni el cierre completo del PRD.

La certificación general del PRD **no es válida como cierre**: U7 conserva definiciones de KPI incorrectas y U8 no fue regenerada.

No se debe regenerar `suite/report-certificacion.md` hasta remediar U7 y U8.

## Evidencia local reciente

| Verificación | Resultado |
|---|---|
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
| Verificación remota completa previa al candidato final | 14/14 definiciones PASS |
| Webhooks Entry | POST canónico + GET healthcheck PASS |

La evidencia 9+33 y los harnesses focalizados cubren el candidato de repositorio. No demuestran que la corrección final esté desplegada.

## Próximo corte

- Mantener U7 y U8 pendientes hasta retomarlas explícitamente.
- Mantener U4 y U9 fuera de alcance.
- Revisar el diff completo y preparar commits por unidad de trabajo antes de cualquier publicación.
- Desplegar únicamente `OPS - Handoff Notification Scheduler` mediante el procedimiento controlado, con snapshot, paridad y rollback.
- No reusar, reejecutar (`replay`) ni reintentar el outbound `unknown/reconciliation_required`; reconciliarlo como evidencia persistente.
- Ejecutar una nueva aceptación externa sólo con una autorización independiente y un teléfono de prueba controlado.
- Mantener evidencia separada de repositorio, runtime y efectos externos.
