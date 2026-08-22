# Plan de remediación — corte 2026-08-22

Base verificada: `HEAD 32df513` en `feat/afinar-hormi-atencion`, sincronizada con su remoto.
Runtime operativo: 4 contenedores arriba hace 12 h, schedulers ejecutando cada minuto sin fallos.

Todos los hallazgos de este plan fueron verificados empíricamente contra el repositorio,
el runtime de n8n y las bases `crm_whatsapp` / `crm_whatsapp_app`. Los ítems descartados
por verificación están registrados al final para que no se reabran.

---

## Resumen de prioridades

| # | Problema | Impacto | Esfuerzo | Bloquea entrega |
|---|----------|---------|----------|-----------------|
| ~~P1~~ | ~~Cadena de handoff a ClickUp rota~~ | Retirado: no es un defecto (ver apartado) | — | No |
| P2 | Compose de test colisiona con producción local | Caída de producción por error humano | Bajo | Sí |
| P3 | CI no ejecuta `tests/unit/` | Regresiones silenciosas en dos fixes de seguridad | Bajo | Sí |
| P4 | Guardrail versionado no desplegado | El fix no protege a nadie todavía | Bajo | Sí |
| P5 | Escalaciones y handoffs sin cierre operativo | Leads perdidos | Medio | No |
| P6 | Documentación canónica obsoleta | Decisiones sobre estado falso | Bajo | No |
| P7 | Higiene de repositorio y rama | Trabajo no versionado, `main` sin protección | Bajo | No |

---

## P1 — Retirado: la cadena de handoff no está rota

La versión inicial de este plan clasificaba como P1 una «cadena de handoff a ClickUp rota»,
a partir de dos handoffs en `pending` sin notificar y de que ningún handoff tuviera
`resolved_at`. El diagnóstico posterior demuestra que no hay tal defecto. Se conserva el
apartado con la evidencia para que la conclusión no se reabra.

### Los dos handoffs en `pending` son artefactos de prueba preservados a propósito

```
handoff 1 | [CONTROLLED_TEST_NUMBER] | pending | notification_attempt_count 0 | max_attempts 3
handoff 6 | [CONTROLLED_TEST_NUMBER] | pending | notification_attempt_count 0 | max_attempts 3
last_notification_error = preserved_test_artifact_closed_no_replay
```

`preserved_test_artifact_closed_no_replay` no es un error de integración: es un marcador
deliberado. Ambos pertenecen a un número controlado de pruebas redactado, y
`README.md` los documenta de forma explícita como registros históricos cerrados sin
reintento, conservados como evidencia, que **no deben reejecutarse ni reintentarse**. Las
operaciones externas 89 y 90 llevan ese mismo marcador. El commit `6102278` ya había
registrado este cierre.

### Que ningún handoff tenga `resolved_at` es una funcionalidad no cableada, no una falla

`db/queries/n8n/handoff-routing/04_advance_handoff_state.sql` es la única sentencia capaz de
escribir `resolved_at`, y ningún workflow la referencia. Ninguna ruta de código del sistema
en ejecución puede marcar un handoff como `acknowledged` ni `resolved`. El cierre ocurre en
ClickUp, y esta base nunca se entera. `0 de 6 resueltos` es, por lo tanto, el valor esperado.

### El estado actual de escalamiento funciona

```
Primer handoff registrado: 2026-08-12
Escalaciones desde el 12/08 CON handoff: 3
Escalaciones desde el 12/08 SIN handoff: 1  (conversación 126, número controlado, del propio 12/08)
```

Existen 9 conversaciones en `escalation_required` sin handoff, pero todas son anteriores al
12 de agosto, fecha en que se cableó la funcionalidad. De ellas, 7 son sintéticas: cinco
(conversaciones 107 a 111) forman un lote correlativo `5698630xxxx` con 4 mensajes y 2
eventos inbound cada una, todas del 2026-08-09, y dos pertenecen al número controlado.

### Lo único que requiere clasificación fuera del código

Dos identidades históricas escalaron a comienzos de agosto y no fueron enrutadas, porque la
funcionalidad de handoff todavía no existía. Sus teléfonos se omiten deliberadamente para no
publicar datos personales en el repositorio:

```
conversación 99 | [PHONE_REDACTED] | 26 mensajes | 98 eventos inbound | 2026-08-08
conversaciones 90, 92, 94 | [PHONE_REDACTED] | 10-12 mensajes c/u | 108 eventos inbound | 01-07/08
```

Una de estas identidades fue utilizada posteriormente como número controlado de aceptación,
por lo que no deben clasificarse automáticamente como clientes reales. No es un defecto de
software vigente: la identidad y cualquier acción comercial requieren verificación del negocio.

### Tareas restantes

1. Verificar fuera del repositorio la identidad y procedencia de ambos registros antes de
   cualquier contacto. No requiere cambio de código ni publicar los teléfonos.
2. Cablear el ciclo de vida del handoff más allá de `notified`, o retirar
   `04_advance_handoff_state.sql` como código muerto. Baja urgencia: hoy nadie lo invoca.

---

## P2 — Aislar el Compose de test del stack de producción

### Evidencia

```
docker compose -f docker-compose.test.yml config  ->  name: automatizacion-whatsapp

Contenedores en ejecución, label com.docker.compose.project:
  crm-whatsapp-automatizado-postgres       -> automatizacion-whatsapp
  crm-whatsapp-automatizado-n8n            -> automatizacion-whatsapp
  crm-whatsapp-automatizado-redis          -> automatizacion-whatsapp
  crm-whatsapp-automatizado-evolution-api  -> automatizacion-whatsapp
```

Ningún archivo Compose declara `name:`, por lo que ambos derivan el nombre de proyecto del
directorio. El vector de daño es humano: `docs/rollback/ROLLBACK_PLAN_TEST_HARNESS.md`
documenta `docker compose -f docker-compose.test.yml down -v --remove-orphans` para
ejecución local. Corrido desde la raíz del repositorio, ese comando opera sobre el proyecto
de producción: elimina sus contenedores y, con `--remove-orphans`, también `redis` y
`evolution-api`, que no están declarados en el archivo de test.

Alcance real del daño: caída del stack productivo y reemplazo de contenedores. Los volúmenes
named de producción (`postgres_data`, `n8n_data`, `redis_data`, `evolution_instances`,
`media_storage`) no están declarados en `docker-compose.test.yml`, por lo que `-v` no los
elimina y los datos sobreviven.

`scripts/ops/test-reengagement-n8n-e2e.sh` ya está aislado con
`-p whatsapp-reengagement-e2e` y no constituye un vector.

### Tareas

1. Declarar `name: automatizacion-whatsapp-test` en `docker-compose.test.yml`.
2. Declarar `name: automatizacion-whatsapp` explícitamente en `docker-compose.yml` para que
   el nombre de proyecto de producción no dependa del nombre del directorio.
3. Añadir al job `compose-contract` de CI una aserción sobre el nombre de proyecto
   resuelto, de modo que la regresión quede detectada:
   `test "$(docker compose -f docker-compose.test.yml config --format json | jq -r .name)" = "automatizacion-whatsapp-test"`
4. Actualizar los tres comandos de `docs/rollback/ROLLBACK_PLAN_TEST_HARNESS.md` una vez
   aplicado el cambio.

### Criterio de aceptación

`docker compose -f docker-compose.test.yml config` resuelve a un nombre de proyecto distinto
del de producción, y CI falla si esa separación se rompe.

---

## P3 — Ejecutar `tests/unit/` en CI

### Evidencia

`.github/workflows/parity-validation.yml` ejecuta `check:parity`, `check:sql-references`,
`test:property`, `test:smoke`, `test:fixture-contract`, `test:integration:postgres` y
`test:e2e:n8n`. No ejecuta `npm test`.

`tests/unit/` contiene 13 archivos y 40 tests, verificados en verde localmente
(`npx vitest run tests/unit` — 13 passed, 40 passed, 1.23 s). Ninguno se ejecuta en CI.
Entre ellos:

- `ai-derivation-guardrail.test.js` — protege el fix `8832b1f` contra promesas falsas de derivación.
- Doce tests de wrapper real de nodos Code, incorporados en `adcbb38`.

Los dos commits de corrección más recientes están respaldados por tests que el pipeline
nunca ejecuta.

### Tareas

1. Añadir a `package.json` el script `"test:unit": "vitest run tests/unit --globals"`.
   No usar `npm test` directamente en CI: `vitest run --globals` recorre también `contract` e
   `integration`, que requieren tiempos de espera ampliados y PostgreSQL, y produciría fallos
   por configuración, no por regresión.
2. Añadir el paso correspondiente al job `static-contracts` del workflow.
3. Incorporar `tests/unit/**` a los filtros `paths` de los disparadores `push` y
   `pull_request` (hoy `tests/**` ya los cubre; confirmar tras el cambio).

### Criterio de aceptación

Un push que rompa el guardrail de derivación deja CI en rojo.

---

## P4 — Desplegar el guardrail al runtime

### Evidencia

Comparación por hash del contenido de `jsCode` y `query` de los 14 workflows entre el
repositorio y `workflow_entity` de la base de n8n:

```
13 workflows          -> OK
WA - Conversation Orchestrator -> repo 187378cf2d7b | live 97c92f644a80  DRIFT
```

El token `NO_FALSE_DERIVATION_PROMISE` está presente en
`n8n/workflows/wa-conversation-orchestrator.json` y ausente en la definición viva.
`updatedAt` del workflow en runtime es `2026-08-21 12:20:50`; el commit `8832b1f` es de
`2026-08-21 17:55:54`.

El drift es de un único workflow. El resto del runtime coincide con el repositorio.

### Tareas

1. Ejecutar P3 antes que este paso, para que el despliegue quede respaldado por CI.
2. Sincronizar `WA - Conversation Orchestrator` mediante `scripts/dev/sync-n8n-workflows.sh`.
3. Reejecutar la comparación por hash y confirmar los 14 workflows en `OK`.
4. Validar en una conversación controlada con
   `scripts/ops/reset-controlled-test-session.sh` (ver P7.2) que una respuesta que prometa
   derivación sin `shouldCreateLead` ni `isEscalation` queda bloqueada.

### Criterio de aceptación

Los 14 workflows coinciden por hash entre repositorio y runtime, y el guardrail se observa
activo en una conversación real.

---

## P5 — Cierre operativo de escalaciones y handoffs

### Evidencia

```
Conversaciones no terminales sin avance:
  id 129 | escalation_required | 16 h
  id 137 | escalation_required | 2 d 21 h
  id 128 | escalation_required | 4 d 16 h
  id 130 | waiting_user | city_retry_2 | 8 d
  id 127 | waiting_user | confirm      | 9 d

follow_ups: 171 cancelled | 15 sent | 8 pending | 5 error
handoffs: 0 de 6 con resolved_at
```

Tres conversaciones marcadas como escalación pendiente llevan días sin resolución. La tasa de
cancelación de follow-ups es del 86 %, valor que debe explicarse antes de considerarse normal.

### Tareas

1. Determinar si `escalation_required` tiene un consumidor real o si es un estado terminal
   de hecho. Si no lo tiene, es una fuga de leads, no una cola.
2. Auditar los 171 follow-ups cancelados por `lost_reason` y `motivo`, y confirmar que la
   cancelación responde a la política A-010 y no a un error de cancelación anticipada.
3. Revisar los 5 follow-ups en `error` (último: 2026-08-14).
4. Definir la operación de cierre de handoffs: qué evento escribe `resolved_at` y quién lo
   dispara.

### Criterio de aceptación

Existe un consumidor definido para `escalation_required` y un criterio documentado de cierre
de handoff. La tasa de cancelación de follow-ups queda explicada o corregida.

---

## P6 — Actualizar la documentación canónica

### Evidencia

`docs/estado-actual-2026-08-08.md` se declara «corte canónico actualizado 2026-08-17», fija
`HEAD d38c371` y afirma que la remediación no está desplegada. El HEAD real es `32df513`,
74 commits por delante de `origin/main`.

### Tareas

1. Reescribir el corte canónico contra `32df513` y el estado verificado en este plan.
2. Corregir en el mismo documento la afirmación sobre despliegue: el drift es de un único
   workflow, no del runtime completo.
3. Renombrar el archivo o adoptar un nombre estable sin fecha, para evitar que cada corte
   genere un documento nuevo que compita por ser canónico.

---

## P7 — Higiene de repositorio y rama

### Evidencia

```
Sin versionar:
  ./-l                                        (archivo vacío, residuo de un comando mal tipeado)
  scripts/ops/reset-controlled-test-session.sh (trabajo real, 40+ líneas, sin commitear)

Rama: feat/afinar-hormi-atencion — 74 commits por delante de origin/main, 1 por detrás
Pull requests abiertos: ninguno
Protección de main: desactivada
Worktrees: 4, incluido Automatizacion-WhatsApp-worktrees/ai-prd-contract en 32c1de7
```

### Tareas

1. Eliminar `./-l`.
2. Versionar `scripts/ops/reset-controlled-test-session.sh`, que además es la herramienta de
   validación de P4.4.
3. Abrir el pull request de `feat/afinar-hormi-atencion` hacia `main`. Setenta y cuatro
   commits sin integrar en una rama de trabajo es riesgo de divergencia acumulada.
4. Activar protección de rama sobre `main` con los checks de CI como requeridos. Sin esto,
   los cinco jobs en verde son informativos y no bloquean nada.
5. Decidir el destino del worktree `ai-prd-contract`: integrar o descartar.

---

## Descartado por verificación

Estos puntos fueron investigados en esta auditoría y no constituyen defectos. Se registran
para evitar que se reabran.

**El formato codificado de `current_step` no es corrupción de datos.**
Treinta y dos de 103 conversaciones almacenan `current_step` como
`campo|urlencoded(JSON)`. Es un diseño deliberado: `encodeStep`, `parseStep` y
`pickRicherStep` en `evaluate-conversation-step.js` y `apply-ai-assistance.js` implementan
esa codificación, y `pickRicherStep` prefiere explícitamente el valor que contiene `|`.
No existe SQL que compare `current_step` por igualdad, y la consulta de consistencia
`current_step ~ '\|' AND qualification_context = '{}'` devuelve 0 filas: la escritura dual es
coherente. Queda como redundancia de diseño de baja prioridad, no como defecto.

**Los workflows inactivos en n8n no son un problema.**
`WA - Conversation Orchestrator`, `WA - Inbound Downstream Dispatcher`,
`CRM - Lead Creation And Assignment` y otros figuran como `active = false`. Todos son
`executeWorkflowTrigger`, es decir, sub-workflows invocados por otro workflow. En n8n solo
requieren activación los workflows con disparador propio de webhook o schedule, y los cinco
que lo tienen están activos y ejecutándose sin fallos.

**La presión de memoria del host no proviene de los contenedores.**
El host reporta 564 MiB disponibles de 3.8 GiB y 2.4 GiB de swap en uso. Los cuatro
contenedores suman aproximadamente 385 MiB. La presión proviene del utillaje de desarrollo
que corre en la misma máquina, no del stack. El disco tiene 885 GiB libres.

---

## Orden de ejecución sugerido

```
P2  ->  P3  ->  P4  ->  P7  ->  P5  ->  P6
```

P2 primero porque elimina el riesgo de que cualquier trabajo posterior tire producción.
P3 antes de P4 para que el despliegue del guardrail quede cubierto por CI.
P1 se retiró tras el diagnóstico: no era un defecto.

Estado al 2026-08-22: P2 entregado (`0d4027a`), P3 entregado (`b94c485`), CI run 32582335078
verde en los 5 jobs. P4 queda a la espera del número controlado para la aceptación.
