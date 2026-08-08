# Estado actual — 2026-08-08

Este es el corte canónico del proyecto. El repositorio contiene remediaciones verificadas que todavía **no fueron publicadas ni aplicadas al runtime**.

## Resumen ejecutivo

| Área | Estado |
|---|---|
| Rama | `feat/afinar-hormi-atencion` |
| HEAD base | `80718c3` |
| Divergencia remota | 21 commits ahead de `origin/feat/afinar-hormi-atencion` |
| Working tree | 51 archivos: 30 modificados, 7 eliminados y 14 nuevos |
| Unidades completas en HEAD | U0 y U2 |
| Remediaciones locales sin commit | U1, U3, U5 y U6 |
| Pendientes por decisión | U4, U7, U8 y U9 |
| Publicación | Sin commit, push ni deploy de las remediaciones locales |

## Estado por capa

### Repositorio

- **U1:** corregida la continuidad conversacional y la conservación del contexto válido.
- **U3:** implementada la entrega durable de notificaciones ClickUp con claim y reintentos.
- **U5:** implementada la descarga segura de media mediante Evolution API, persistencia real y recuperación durable.
- **U6:** implementado el scheduler de follow-up con opt-out durable y manejo seguro de resultados ambiguos.
- **U4, U7, U8 y U9:** permanecen fuera del cambio actual por decisión.
- **U7:** siguen abiertos los errores de definición de KPI-19, KPI-26 y KPI-29.

### Runtime

El runtime no refleja todavía las remediaciones locales. Antes de validarlas en un ambiente deben:

1. aplicarse las migraciones `015`, `016` y `017`;
2. importarse y activarse los workflows OPS nuevos o modificados;
3. configurarse credenciales, variables y almacenamiento persistente;
4. ejecutarse el preflight, la verificación remota y un E2E controlado.

No debe inferirse estado productivo a partir del working tree.

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
| Integridad dispatcher, sincronización de nodos, JSON y `git diff --check` | PASS |

Esta evidencia demuestra consistencia local del repositorio; no reemplaza migración, importación, configuración ni pruebas sobre el runtime objetivo.

## Próximo corte

- Mantener U7 y U8 pendientes hasta retomarlas explícitamente.
- Mantener U4 y U9 fuera de alcance.
- Cuando se autorice el despliegue, seguir [`guia-produccion.md`](./guia-produccion.md) y registrar evidencia separada de repositorio y runtime.
