# hormi-mantenimiento-watchdog — Specification

## Purpose

Define el comportamiento del agente watchdog **Hormi Mantenimiento**: monitoreo
periódico de 7 checks operativos sobre PostgreSQL (`crm_whatsapp_app`), análisis
LLM de anomalías, reporte al operador vía Telegram (chat 1:1), persistencia de
estado dual (JSON local + tabla `monitor_snapshots`), y trigger crítico de baja
latencia (~1 min) que **no consume tokens del LLM** cuando el sistema está sano.

---

## Requirements

### F-R1: Monitoreo de Mensajes Atascados (cadencia: 5 min)

| Atributo | Valor |
|----------|-------|
| **Cadencia** | 5 min (OpenClaw cron) |
| **Severidad** | WARN si ≥1 atascado, CRITICAL si ≥5 |

El agente MUST detectar mensajes outbound con `delivery_status = 'queued'` cuya
antigüedad supere los 5 minutos (`created_at < NOW() - INTERVAL '5 minutes'`).

El reporte MUST incluir:
- Conteo total de mensajes atascados.
- Números afectados (`conversations.phone_number`).
- Antigüedad máxima y promedio en minutos.

El reporte SHOULD agrupar por `provider_instance_name` cuando esté disponible.

**Índices usados**: `idx_messages_conversation_id`, `idx_conversations_phone_number`.
`delivery_status` sin índice pero es baja cardinalidad.

#### Scenario: Mensajes atascados detectados

- **GIVEN** 2 mensajes outbound con `delivery_status = 'queued'` creados hace 7 y 12 minutos
- **AND** 1 mensaje en `queued` creado hace 1 minuto
- **WHEN** el check F-01 se ejecuta
- **THEN** el reporte MUST indicar **2 mensajes atascados**
- **AND** los `phone_number` afectados se listan
- **AND** la antigüedad máxima es **12 min**
- **AND** el mensaje de 1 minuto NO debe aparecer

#### **Scenario: Sin mensajes atascados**

- **GIVEN** todos los mensajes outbound tienen `delivery_status <> 'queued'`
  o su antigüedad es < 5 minutos
- **WHEN** el check F-01 se ejecuta
- **THEN** el contador es **0** y el estado es **OK**

---

### F-02: Monitoreo de IA Fallando (cadencia: 15 min)

| Atributo | Valor |
|----------|-------|
| **Cadencia** | 15 min |
| **Umbral WARN** | Ratio > 50% o 5+ fallos consecutivos en 10 min |

El agente MUST contar `advisor_decisions` con
`validation_result IN ('fallback', 'error')` en ventana de 15 minutos hacia
atrás. MUST calcular el ratio = `fallos / total × 100`.

El agente SHOULD alertar si el ratio supera 50% o si hay **5+ fallos
consecutivos sin ningún `accepted` intermedio** en los últimos 10 minutos.

**Índices usados**: `idx_advisor_decisions_created_at`. `validation_result`
tiene CHECK pero no índice; es filtro WHERE de baja cardinalidad (4 valores).

#### **Scenario: IA funcionando normalmente**

- **GIVEN** en la ventana de 15 min hay 42 `advisor_decisions` totales
- **AND** solo 3 tienen `validation_result IN ('fallback', 'error')`
- **WHEN** el check F-02 se ejecuta
- **THEN** el ratio calculado es **~7.1%** (< 50%)
- **AND** el estado reportado es **OK**

#### **Scenario: Cascada de fallos AI — alerta crítica**

- **GIVEN** en los últimos 10 min hay 7 `advisor_decisions`, todas con
  `validation_result IN ('fallback', 'error')`
- **AND** `confidence < 0.5` en 5 de ellas
- **WHEN** el check F-02 se ejecuta
- **THEN** el ratio es **100%** (> 50%)
- **AND** el agente reporta **CRITICAL** con detalle de cascada
- **AND** la recomendación sugiere revisar `validation_result` recientes y
  conectividad con la API de NVIDIA/Gemini

#### **Scenario: Fallos aislados, sin cascada**

- **GIVEN** 3 fallos intercalados con 3 `accepted` en los últimos 10 min
- **WHEN** F-02 se ejecuta
- **THEN** el estado es **OK** (hay éxitos intermedios)

---

### F-03: Monitoreo de ClickUp (cadencia: 15 min)

| Atributo | Valor |
|----------|-------|
| **Cadencia** | 15 min |
| **Umbral** | 3+ fallos consecutivos sin éxito intermedio |

El agente MUST detectar `external_operations` con `status = 'failed'` para
`operation_type LIKE '%clickup%'` en la ventana de 15 minutos.

El agente MUST alertar si hay **3+ fallos consecutivos** sin éxito intermedio
(`status = 'succeeded'` entre ellos).

El agente SHOULD distinguir entre:
- **Timeout**: `last_error` contiene `timeout` (sin código HTTP claro)
- **4xx**: `last_error` contiene código 400–499 (posible bad config)
- **5xx**: `last_error` contiene código 500–599 (posible downtime)

**Índices usados**: `idx_external_operations_status` (cubre `status` + `locked_at`).

#### **Scenario: ClickUp funciona normalmente**

- **GIVEN** solo 1 `external_operation` con status = `failed` y
  `operation_type LIKE '%clickup%'` en los últimos 15 min
- **AND** hay 4 operaciones `succeeded` en esa ventana
- **WHEN** F-03 se ejecuta
- **THEN** NO se alerta (no hay 3+ fallos consecutivos)

#### **Scenario: ClickUp caído (fallos consecutivos)**

- **GIVEN** los últimos 4 `external_operations` para `%clickup%` tienen
  `status = 'failed'`
- **AND** `last_error` más reciente: `timeout`, el anterior: `413 Request Entity Too Large`
- **WHEN** F-03 se ejecuta
- **THEN** se reporta **CRITICAL**: 4 fallos consecutivos
- **AND** el último error es taggeado como *timeout*
- **AND** recomienda verificar conectividad con ClickUp

---

### F-04: Monitoreo de Leads No Asignados (cadencia: 15 min)

| Atributo | Valor |
|----------|-------|
| **Cadencia** | 15 min |
| **Umbral** | leads > 30 min sin vendedor con sellers disponibles |

El agente MUST detectar leads con:
- `assigned_seller_id IS NULL`
- `deleted_at IS NULL`
- `lead_statuses.code IN ('qualified_complete', 'qualified_partial', 'created_in_clickup', 'assigned')`
- `created_at < NOW() - INTERVAL '30 minutes'`

Si se detectan, MUST verificar cuántos **sellers activos y notificables**
existen (`deleted_at IS NULL AND is_active = TRUE AND clickup_user_id IS NOT NULL`).

El agente SHOULD reportar si el round-robin está atascado: `assignment_rotations`
con `next_seller_id` que excluye sellers elegibles vía `leader_assignments`
recientes fallidas (assignment_result = 'skipped').

**Índices usados**: `idx_leads_assigned_seller_id`, `idx_leads_status_id`.

#### **Scenario: Lead no asignado con sellers disponibles**

- **GIVEN** 2 leads en `qualified_complete` desde hace 45 min, sin `assigned_seller_id`
- **AND** hay 3 sellers activos con `clickup_user_id` no nulo
- **WHEN** F-04 se ejecuta
- **THEN** el reporte indica **2 leads no asignados**
- **AND** incluye el contador de vendedores disponibles (**3**)
- **AND** sugiere revisar el round-robin

#### **Scenario: Lead recién qualifies (dentro de los 30 min)**

- **GIVEN** un lead en `qualified_complete` hace solo 10 minutos, sin `assigned_seller_id`
- **WHEN** F-04 se ejecuta
- **THEN** ese lead **NO** debe aparecer (antigüedad < 30 min)

---

### F-05: Monitoreo de Conversaciones Colgadas (cadencia: 60 min)

| Atributo | Valor |
|----------|-------|
| **Cadencia** | 60 min |
| **Umbral** | `last_message_at > 24h` + status distinto de `closed` |

El agente MUST reusar la lógica de `monitor-active-conversations.sql`
(especificada en `openspec/specs/monitor-active-conversations/spec.md`).

Se consideran "colgadas" las conversaciones con:
- `last_message_at < NOW() - INTERVAL '24 hours'`
- `conversation_statuses.code NOT IN ('closed')`
- `deleted_at IS NULL`

El agente MUST incluir en el reporte: `lead_id`, servicio, ciudad, vendedor
asignado de cada conversación colgada.

**Índices usados**: `idx_conversations_last_message_at`,
`idx_conversations_lead_id`.

#### **Scenario: Conversación colgada por 24+ horas**

- **GIVEN** conversación con `last_message_at = NOW() - INTERVAL '30 hours'`
  y status = `handed_to_sales`
- **AND** lead asociado: servicio 'terraza', ciudad 'Buenos Aires', vendedor 'Martín'
- **WHEN** F-05 se ejecuta
- **THEN** se califica como **colgada**
- **AND** se incluyen los datos contextuales del lead

#### **Scenario: Sin conversaciones colgadas**

- **GIVEN** todas las conversaciones activas tienen `last_message_at` dentro
  de las últimas 24 horas
- **WHEN** F-05 se ejecuta
- **THEN** el contador es **0** y el estado es **OK**

---

### F-06: Salud General del Sistema (cadencia: 30 min)

| Atributo | Valor |
|----------|-------|
| **Cadencia** | 30 min |
| **Severidad** | OK / WARN si hay anomalía |

El agente MUST reportar:
- **Volumen**: mensajes `incoming` / `outgoing` en los últimos 30 minutos.
- **Errores de IA**: `advisor_decisions.validation_result = 'error'`
  en la última hora, incluyendo ratio vs total.
- **Estado de triggers**: si hay sellers activos y `assignment_rotations`
  sin errores (o evidencia de round-robin funcionando).

El agente MUST incluir comparación "qué cambió" vs. la ejecución anterior
via último registro para `check_name = 'general_health'` en `monitor_snapshots`.

El agente SHOULD incluir health check del gateway OpenClaw (probar con `curl`
al puerto 18789) e indicar si el gateway NO responde.

**Índices usados**: `idx_messages_external_timestamp` (approximate — no exacto
para `direction` solo), `idx_advisor_decisions_created_at`.

#### **Scenario: Sistema sano**

- **GIVEN** en esta ventana de 30 min hay 54 inbound, 42 outbound,
  0 errores de `advisor_decisions`
- **AND** la ejecución anterior (monitor_snapshots): 50 inbound, 40 outbound
- **WHEN** F-06 se ejecuta
- **THEN** se reporta **Salud General: OK**
- **AND** tendencia: +4 inbound, +2 outbound vs anterior

#### **Scenario: Gateway caído (health check adicional)**

- **GIVEN** `curl -s localhost:18789/health` no responde
- **AND** el check F-06 se ejecuta según la cadencia
- **THEN** además del reporte de salud, se indica: **"Gateway OpenClaw no responde"**
- **AND** se recomienda verificar `sudo systemctl status openclaw-gateway`

---

### F-07: Alertas Críticas — Trigger 1 min (CERO tokens sin crisis)

| Atributo | Valor |
|----------|-------|
| **Cadencia** | ~1 min (cron shell, sin LLM) |
| **Severidad** | CRITICAL |
| **Regla de wake** | Solo si condición SQL dispara positiva |

El sistema MUST tener un trigger de aproximadamente 1 minuto: es un **job shell**
de OpenClaw (`--command <script>`) que NO utiliza el agente ni el modelo LLM.

El script shell MUST ejecutar 3 condiciones SQL contra PostgreSQL:

1. **CASCADA de AI**: ≥5 `advisor_decisions.validation_result IN ('fallback','error')`
   en los últimos 10 minutos, **sin** resultados `accepted` intermedios.
2. **ClickUp DOWN**: ≥5 `external_operations.status = 'failed'` **consecutivas**
   para `operation_type LIKE '%clickup%'`, sin éxito intermedio.
3. **SILENCIO**: 0 `inbound_events` cuyo `received_at > NOW() - INTERVAL '30 minutes'`.

Si **TODO es falso**, el script sale con código 0 y el LLM nunca es invocado
→ **CERO tokens consumidos** en esa ejecución (NFR-02).

Solamente cuando alguna condición es verdadera, el script ejecuta:
`openclaw agent --message "CRITICAL: ..." --agent hormi-mantenimiento --announce --to <chatId>`

El mensaje enviado debe incluir 🚨 emoji de crisis + severidad + detalle de qué
condición se disparó + datos relevantes.

**Índices usados**: `idx_advisor_decisions_created_at`,
`idx_external_operations_status`, `inbound_events.received_at` (sin índice
dedicado — verifiＣamos que haya al menos parcial en PR next).

#### **Scenario: OK — sin despertar al LLM**

- **GIVEN** ninguna de las 3 condiciones SQL da true
- **WHEN** el script shell se ejecuta
- **THEN** el script sale con código **0**
- **AND** el agente nunca es invocado (`openclaw agent` never called)
- **AND** el número de tokens consumidos es **0**

#### **Aprendiz: Alerta crítica — AI cascada**

- **GIVEN** 7 `advisor_decisions` consecutivas en los últimos 10 min tienen
  `validation_result IN ('fallback','error')`
- **AND** todas fueron registradas sin decisión `accepted` intermedia
- **WHEN** el trigger 1-min se ejecuta
- **THEN** la **condición SQL #1** devuelve true
- **AND** el trigger shell ejecuta
  `openclaw agent --message "CRITICAL: ..." --agent hormi-mantenimiento --announce --to <chatId>`
- **AND** el mensaje de Telegram tiene 🚚 prefix y detalle de los fallos

#### **Scenario: Silencio total**

- **GIVEN** la tabla `inbound_events` no tiene registros con
  `received_at > NOW() - INTERVAL '30 minutes'`
- **WHEN** el trigger 1-min se ejecuta
- **THEN** la **condición SQL 3** devuelve true
- **AND** se envía alerta "🚨 CRITICAL: no ingresa información al bot"

---

---

## Requisitos No-Funcionales

### N-01: Timeout por cron job

Cada trabajo cron de rutina (F-01 F-06) MUST tener `--timeout ≤ 120 segundos`
para evitar que un trabajo bloqueado acumule tokens.

### N-02: Ahorro de tokens en trigger 1-min

El trigger de 1 minuto (F-07) MUST consumir **0 tokens** del modelo LLM cuando
el sistema está sano (condición SQL falsa). Implementación: shell script que
consulta PostgreSQL y sale `if` no hay crisis. Verificación: monitorear >60
min de silencio en billing NVIDIA.

### N-03: Acceso a PostgreSQL

El agente MUST acceder al DB mediante:
`docker compose --env-file .env exec -T postgres psql -U postgres -d crm_whatsapp_app`
(patrón documentado en `db/queries/ops/monitor-active-conversations.sql`).

### N-04: Formato de reportes

Los reportes MUST ser **en español** (lenguaje del operador), con formato
**Markdown compatible con Telegram**: `*bold*`, `_italic_`, `👤 code 👤`.
- **OK**: 🟢
- **WARN**: 🟡
- **CRITICAL**: 🚨 + prefijo "URGENTE"
- Incluyen estado, qué cambió vs. último snapshot, y recomendación solo si WARN/CRITICAL.

### N-05: Estado dual

El agente debe persistir estado en:
1. **JSON workspace**:
   `~/.openclaw/agents/hormi-mantenimiento/workspace/state/last-snapshot.json`
   (temporal, rápido, sobrescribe cada ejecución).
2. **Tabla `monitor_snapshots`** en PostgreSQL:
   ```sql
   CREATE TABLE monitor_snapshots (
     id BIGSERIAL PRIMARY KEY,
     check_name TEXT NOT NULL,
     severity TEXT NOT NULL
       CHECK (severity IN ('OK','WARN','CRITICAL')),
     payload JSONB NOT NULL DEFAULT '{}'::JSONB,
     verdict TEXT NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   );
   ```
   Append-only; la queries de tendencia deberán usar `check_name` + `created_at DESC LIMIT 1`.

### N-06: Performance SQL con columnas indexadas

Cada query SQL debe usar columnas con índices existentes:

| Check | Índice(s) principal(es) activado(s) |
|-------|----------------------------------------|
| F-01  | `idx_messages_conversation_id`, `idx_conversations_phone_number` |
| F-02  | `idx_advisor_decisions_created_at` |
| F-03  | `idx_external_operations_status` |
| F-04  | `idx_leads_assigned_seller_id`, `idx_leads_status_id` |
| F-05  | `idx_conversations_last_message_at`, `idx_conversations_lead_id` |
| F-06  | `idx_advisor_decisions_created_at`, `idx_conversations_external_timestamp` (approximate) |
| F-07  | `idx_advisor_decisions_created_at`, `idx_external_operations_status` |

`delivery_status` (F-01) y `validation_result` (F-02) no tienen índices pero son
columnas de baja cardinalidad (4 estados) y sirven como filtro posterior al
`index_read.*` plan ejecutor es eficiente.

---

## Inputs & Outputs

### Inputs
- Variables de entorno (`PGUSER`, `PGPASSWORD`, `PGDATABASE` del `.env`)
- Data real de PostgreSQL (`crm_whatsapp_app`)
- `NOW()` timestamp de ejecución
- Estado previo del snapshot (`last-snapshot.json` o `monitor_snapshots`)

### Outputs
- Mensajes de Telegram al chat 1:1 del operador (formato N-04)
- Registro persistente en `monitor_snapshots` (una fila por check por ejecución)
- Archivo local `last-snapshot.json` actualizado en workspace del agente