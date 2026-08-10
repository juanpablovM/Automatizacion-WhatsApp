# Estado actual — 2026-08-08

Este es el corte canónico del proyecto. Las remediaciones U1/U3/U5/U6 están desplegadas en el runtime local; los últimos blindajes del pipeline permanecen sin commit ni push.

## Resumen ejecutivo

| Área | Estado |
|---|---|
| Rama | `feat/afinar-hormi-atencion` |
| HEAD | `32c1de7` |
| Divergencia remota | 1 commit ahead de `origin/feat/afinar-hormi-atencion` |
| Working tree | Blindajes n8n, regresiones y este estado sin commit |
| Unidades remediadas | U1, U3, U5 y U6 |
| Runtime | Migraciones `015`–`017`, schedulers OPS y webhook canónico activos |
| Pendientes por decisión | U4, U7, U8 y U9 |
| Publicación | Runtime reparado; cambios de blindaje aún sin commit ni push |

## Estado por capa

### Repositorio

- **U1:** corregida la continuidad conversacional y la conservación del contexto válido.
- **U3:** implementada la entrega durable de notificaciones ClickUp con claim y reintentos.
- **U5:** implementada la descarga segura de media mediante Evolution API, persistencia real y recuperación durable.
- **U6:** implementado el scheduler de follow-up con opt-out durable y manejo seguro de resultados ambiguos.
- **U4, U7, U8 y U9:** permanecen fuera del cambio actual por decisión.
- **U7:** siguen abiertos los errores de definición de KPI-19, KPI-26 y KPI-29.

### Runtime

- Las migraciones `015`, `016` y `017` están aplicadas en `crm_whatsapp_app`.
- `WA - Inbound Entry`, `WA - Inbound Recovery` y los tres schedulers OPS están activos.
- Evolution apunta al POST canónico `.../evolutionwebhook/wa-inbound-entry`; n8n registra ese POST y el GET de healthcheck.
- Las 14 definiciones remotas coinciden con los candidatos locales resueltos.
- El smoke runtime de invocación `Execute Workflow -> OPS - Handoff Notification Scheduler` finalizó correctamente y no dejó workflows temporales.

La reparación se hizo desde un snapshot completo en `backups/runtime-repair-20260808-192944/`, sin enviar mensajes E2E ni crear efectos externos.

### Certificación

La certificación actual **no es válida como cierre del PRD**. La regresión conversacional de U1 ya fue corregida, pero la certificación anterior fallaba con exit `3` porque ejecutaba SQL posicional sin parámetros. Además, U7 conserva definiciones de KPI incorrectas.

No se debe regenerar `suite/report-certificacion.md` hasta remediar U7 y U8.

## Evidencia local reciente

| Verificación | Resultado |
|---|---|
| Gate U1 | 126 PASS / 0 FAIL |
| Regresión conversacional | 30 casos PASS |
| Contrato AI | 7 casos PASS |
| U2 — ciclo de oportunidad | 20 PASS / 0 FAIL |
| U3 — handoff | PASS |
| U5 — media | PASS |
| U6 — follow-up | PASS |
| Bootstrap y contratos de subworkflow | PASS |
| Integridad dispatcher, unicidad de IDs, sincronización de nodos, JSON y `git diff --check` | PASS |
| Verificación remota completa | 14/14 definiciones PASS |
| Webhooks Entry | POST canónico + GET healthcheck PASS |
| Smoke runtime de subworkflow | PASS |

Esta evidencia cubre repositorio y runtime local. Todavía no reemplaza la aceptación externa controlada con un teléfono de prueba.

## Próximo corte

- Mantener U7 y U8 pendientes hasta retomarlas explícitamente.
- Mantener U4 y U9 fuera de alcance.
- Commit/push de los blindajes pendientes después de revisar el diff completo.
- Ejecutar la aceptación externa controlada cuando se disponga de un teléfono de prueba.
- Mantener evidencia separada de repositorio, runtime y efectos externos.
