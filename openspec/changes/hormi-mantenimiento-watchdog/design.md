# Design: hormi-mantenimiento-watchdog

## Technical Approach

Build Hormi Mantenimiento as an isolated OpenClaw agent that runs 8 cron jobs
(7 agent checks + 1 shell critical trigger) querying PostgreSQL via
`docker compose exec -T postgres psql`. State persists dually: a JSON file in
the agent workspace for fast diff, and `monitor_snapshots` in PostgreSQL for
auditable history. The critical trigger is a cheap shell script running every
60s that exits 0 without invoking the LLM when the system is healthy (zero
tokens). Each check embeds its SQL inline in `INSTRUCTIONS.md` per user
decision #5. Telegram chat ID is a placeholder resolved at apply time.

## Architecture Decisions

| Decision | Choice | Tradeoff / Alternatives | Rationale |
|----------|--------|-------------------------|-----------|
| D1 Workspace isolation | `~/.openclaw/agents/hormi-mantenimiento/workspace/` with own config.json | Shared workspace (rejected) — pollutes other agents; symlink (rejected) — fragile | Matches `hormi-atencion` pattern; isolates state.json + scripts |
| D2 Dual state | JSON in workspace + `monitor_snapshots` table | PG-only (rejected) — slow diff read; JSON-only (rejected) — no auditable history | Fast diff for "what changed" + durable audit trail |
| D3 Critical trigger as shell | `critical-trigger.sh` every 60s, wakes LLM only on hit | Agent every 60s (rejected) — burns tokens on idle; pg LISTEN/NOTIFY (rejected) — needs long-lived process | Zero tokens when healthy; design constraint NFR-2 |
| D4 SQL inline in INSTRUCTIONS.md | Embed all SQL in the agent instructions file | Separate `.sql` files in `db/queries/ops/openclaw/` (rejected) | User decision #5; agent reads instructions and runs SQL directly |
| D5 Cron-based scheduling | 8 `openclaw cron add` jobs | systemd timers (rejected) — outside OpenClaw domain; external monitor (rejected) — reimplements | OpenClaw owns agent lifecycle; `--announce --to telegram:id` ships reports |
| D6 7-day retention | cleanup cron deletes `monitor_snapshots` older than 7 days | Keep forever (rejected) — unbounded growth; 1 day (rejected) — loses trend | Covers trend for F-R6 while bounding table size |

## Data Flow

### Check execution flow (F-R1..F-R6, agent-driven)

```
openclaw cron (every Nm)
  │
  ▼
agent hormi-mantenimiento wakes (message in INSTRUCTIONS.md)
  │
  ├─► reads ~/.openclaw/agents/hormi-mantenimiento/workspace/state/monitor-state.json
  │     (last_run, last counts, last_alert_at per check)
  │
  ├─► executes SQL via
  │     docker compose --env-file .env exec -T postgres psql -U ... -d ... -t -A -F $'\t' -c "QUERY"
  │
  ├─► computes severity (ok|warning|critical) per thresholds in INSTRUCTIONS.md
  │
  ├─► compares with previous snapshot → formats Telegram Markdown
  │
  ├─► INSERT INTO monitor_snapshots (check_name, status, summary, metrics, raw_data)
  │
  ├─► updates monitor-state.json  (last_run, checks[check_name].*)
  │
  └─► openclaw sends to telegram:TELEGRAM_CHAT_ID_PLACEHOLDER
```

### Critical trigger flow (F-R7, shell-driven)

```
openclaw cron (every 1m) ──► critical-trigger.sh
  │
  ├─► 3 SQL conditions (AI cascade | ClickUp down | Silence)
  │
  ├─► none true → exit 0  (NO LLM invocation, 0 tokens)
  │
  └─► any true → openclaw cron run hm-critical-alert
                        │
                        ▼
         agent wakes, reads INSTRUCTIONS (§ Alertas Críticas),
         queries PostgreSQL for context, sends 🚨 report
```

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `infra/postgres/migrations/009_create_monitor_snapshots.sql` | Create | Migration for `monitor_snapshots` table, indexes, retention trigger |
| `~/.openclaw/agents/hormi-mantenimiento/agent/config.json` | Create | Isolated agent config with systemPromptFiles + bootstrap limits |
| `~/.openclaw/agents/hormi-mantenimiento/workspace/IDENTITY.md` | Create | Agent persona |
| `~/.openclaw/agents/hormi-mantenimiento/workspace/INSTRUCTIONS.md` | Create | Operational procedures, all inline SQL, threshold tables, report templates |
| `~/.openclaw/agents/hormi-mantenimiento/workspace/state/monitor-state.json` | Create | Initial empty state |
| `~/.openclaw/agents/hormi-mantenimiento/workspace/scripts/critical-trigger.sh` | Create | Shell trigger for F-R7 |
| `~/.openclaw/openclaw.json` | Modify | Point `hormi-mantenimiento.workspace` to isolated path; add 8 cron jobs |
| `db/queries/ops/monitor-active-conversations.sql` | Reuse (no change) | F-R5 reuses existing query; INSTRUCTIONS references it |

## Interfaces / Contracts

### `monitor_snapshots` schema (migration 009)

```sql
-- infra/postgres/migrations/009_create_monitor_snapshots.sql
CREATE TABLE IF NOT EXISTS monitor_snapshots (
  id          BIGSERIAL PRIMARY KEY,
  check_name  TEXT        NOT NULL,
  status      TEXT        NOT NULL CHECK (status IN ('ok','warning','critical')),
  summary     TEXT        NOT NULL,
  metrics     JSONB       NOT NULL DEFAULT '{}'::JSONB,
  raw_data    JSONB       NOT NULL DEFAULT '{}'::JSONB,
  snapshot_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at  TIMESTAMPTZ
);

CREATE INDEX idx_monitor_snapshots_check_at
  ON monitor_snapshots (check_name, snapshot_at)
  WHERE deleted_at IS NULL;

CREATE INDEX idx_monitor_snapshots_snapshot_at
  ON monitor_snapshots (snapshot_at)
  WHERE deleted_at IS NULL;

CREATE TRIGGER set_monitor_snapshots_updated_at
  BEFORE UPDATE ON monitor_snapshots
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Retention: 7-day cleanup (idempotent, safe to rerun)
INSERT INTO cron_jobs (job_name, schedule, command, enabled)  -- if cron framework exists
-- Otherwise document a cleanup cron job in INSTRUCTIONS.md:
-- DELETE FROM monitor_snapshots WHERE snapshot_at < NOW() - INTERVAL '7 days' AND deleted_at IS NULL;
```

### `monitor-state.json` shape

```json
{
  "last_run": "2026-07-28T14:30:00Z",
  "checks": {
    "msg-stuck":    { "status": "ok", "count": 0, "last_alert_at": null },
    "ai-fail":      { "status": "ok", "ratio": 0.07, "last_alert_at": null },
    "clickup":      { "status": "ok", "failed_consec": 0, "last_alert_at": null },
    "leads":        { "status": "ok", "count": 0, "active_sellers": 3, "last_alert_at": null },
    "conversations":{ "status": "ok", "count": 0, "last_alert_at": null },
    "health":       { "status": "ok", "inbound": 12, "outbound": 10, "errors": 0, "ai_confidence": 0.95, "lml": 0.95, "last_alert_at": null },
    "critical":     { "status": "ok", "last_alert_at": null }
  }
}
```

### Telegram report templates (Markdown)

OK report (🧠 prefix, sent by F-R6 every 30 min, or aggregated):
```
🧠 MONITOR • 14:30
✅ Mensajes: 12 in · 10 out · 0 errores
✅ IA: 95% confianza
✅ ClickUp: 3/3 syncs ok
✅ Leads: 1 nuevo, asignado
✅ Conversaciones: 4 activas
```

Warning report (⚠️ prefix, severity = warning):
```
⚠️ MONITOR • 14:30
⚠️ 2 mensajes atascados en 'queued'
• +569XXXXXXXX (7 min)
• +569YYYYYYYY (12 min)
Recomendación: Revisar Evolution API
```

Critical report (🚨 prefix, severity = critical):
```
🚨 ALERTA CRÍTICA • 14:32
🔥 AI cayendo en cascada
• 5 fallos en últimos 10 min
• Confianza promedio: 0.32
• ⚡ Recomendación: Revisar API key de Gemini
```

### `critical-trigger.sh` skeleton

```sh
#!/bin/sh
set -eu

ROOT_DIR=/home/agentesai/Automatizacion-WhatsApp
cd "$ROOT_DIR"

export $(grep -v '^#' .env | xargs)

PSQL="docker compose --env-file .env exec -T postgres psql -U postgres -d crm_whatsapp_app -t -A"

# Condición 1: AI cascada (≥5 fallback/error en 10 min sin accepted intermedio)
AI_CASCADA=$($PSQL -c "SELECT CASE WHEN COUNT(*) >= 5 AND bool_and(validation_result <> 'accepted') THEN 1 ELSE 0 END FROM advisor_decisions WHERE created_at > NOW() - INTERVAL '10 minutes' AND validation_result IN ('fallback','error')")

# Condición 2: ClickUp down (≥5 failed consecutivos sin succeeded en 30 min)
CLICKUP_DOWN=$($PSQL -c "SELECT CASE WHEN COUNT(*) >= 5 AND NOT EXISTS (SELECT 1 FROM external_operations eo2 WHERE eo2.operation_type ILIKE '%clickup%' AND eo2.created_at > NOW() - INTERVAL '30 minutes' AND eo2.status='succeeded') THEN 1 ELSE 0 END FROM external_operations WHERE operation_type ILIKE '%clickup%' AND created_at > NOW() - INTERVAL '30 minutes' AND status='failed'")

# Condición 3: Silencio total (0 inbound_events en 30 min)
SILENCIO=$($PSQL -c "SELECT CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END FROM inbound_events WHERE received_at > NOW() - INTERVAL '30 minutes'")

if [ "$AI_CASCADA" = "1" ] || [ "$CLICKUP_DOWN" = "1" ] || [ "$SILENCIO" = "1" ]; then
  openclaw cron run hm-critical-alert
fi

exit 0
```

### Threshold table (embedded in INSTRUCTIONS.md)

| Check | Freq | ok | warning | critical |
|-------|------|----|---------|----------|
| F-R1 msg-stuck | 5m | 0 stuck | 1-2 stuck | ≥3 stuck |
| F-R2 ai-fail | 15m | ratio ≤0.2 | ratio >0.5 or 3-4 consec | ratio >0.5 AND ≥5 consec |
| F-R3 clickup | 15m | 0 failed consec | 1-2 failed consec | ≥3 failed consec |
| F-R4 leads | 15m | 0 unassigned >30min | >0 + sellers activos | >0 + no sellers activos |
| F-R5 conversations | 60m | 0 idle >24h | 1-3 idle | ≥4 idle |
| F-R6 health | 30m | errors=0, AI≥0.75 | AI 0.5-0.75 | errors>0 OR AI<0.5 |
| F-R7 critical (shell) | 1m | all 0 | — | any 1 |

### Cron jobs (added via `openclaw cron add`)

| # | Name | Type | Every | Message / Command |
|---|------|------|-------|-------------------|
| 1 | hm-critical-trigger | shell | 1m | `bash /home/agentesai/.openclaw/agents/hormi-mantenimiento/workspace/scripts/critical-trigger.sh` |
| 2 | hm-msg-stuck | agent | 5m | "Ejecuta F-R1: Mensajes Atascados…" |
| 3 | hm-ai-fail | agent | 15m | "Ejecuta F-R2: IA Fallando…" |
| 4 | hm-clickup | agent | 15m | "Ejecuta F-R3: ClickUp Caído…" |
| 5 | hm-leads | agent | 15m | "Ejecuta F-R4: Leads No Asignados…" |
| 6 | hm-conversations | agent | 60m | "Ejecuta F-R5: Conversaciones Colgadas…" |
| 7 | hm-health | agent | 30m | "Ejecuta F-R6: Salud General…" |
| 8 | hm-critical-alert | agent | triggered | disabled, woken by job #1 |

All announce to `telegram:TELEGRAM_CHAT_ID_PLACEHOLDER` (resolved at apply time).

## Testing Strategy

| Layer | What to Test | Approach |
|-------|-------------|----------|
| Unit | `critical-trigger.sh` exits 0 with healthy data | seed test fixtures in `crm_whatsapp_app` with zero hits, run script, assert `openclaw cron run` NOT called (mock `openclaw`) |
| Unit | `critical-trigger.sh` wakes agent when crit himmitted | seed 5 `advisor_decisions` fallback in 10 min, run script, assert `openclaw cron run` exited once |
| Integration | `monitor_snapshots` migration applies idempotently | run migration twice against fresh DB, assert table + indexes + trigger exist |
| Integration Each check queries return expected schema | seed fixtures per scenario from spec (F-R1..F-R6), run each SQL block manually and confirm row count + columns |
| E2E | Agent reports to Telegram with correct severity | Send the cron `--message` to a test agent, capture stdout, assert `🚨` / `⚠️` / `✅` prefix matches expected severity for seeded data |
| E2E | Retention deletes >7-day rows | insert a row with `snapshot_at = NOW() - 8 days`, run cleanup SQL, assert row gone |

Strict TDD: each Agent task gets RED before GREEN per `openspec/config.yaml strict_tdd: true`.

## Threat Matrix

N/A — no routing, shell subprocess manipulation, VCS/PR automation, executable-file classification, or process-integration boundary beyond the existing project-approved Docker Compose exec pattern. The single shell script (`critical-trigger.sh`) only runs SQL via the project-sanctioned `docker compose exec -T postgres psql` command documented in `crm-whatsapp` conventions, and an OpenClaw CLI call (`openclaw cron run`) — both pre-existing trusted surfaces. No new process boundary is introduced.

## Migration / Rollout

1. Apply migration `009_create_monitor_snapshots.sql` (`docker compose exec -T postgres psql -d crm_whatsapp_app -f infra/postgres/migrations/009_create_monitor_snapshots.sql`).
2. Create `~/.openclaw/agents/hormi-mantenimiento/` tree with `agent/config.json`, `workspace/IDENTITY.md`, `workspace/INSTRUCTIONS.md`, `workspace/state/monitor-state.json`, `workspace/scripts/critical-trigger.sh`.
3. Edit `~/.openclaw/openclaw.json`: point `hormi-mantenimiento.workspace` to the new path; add 8 cron jobs.
4. Replace `TELEGRAM_CHAT_ID_PLACEHOLDER` in cron jobs with the real chatId once the user provides it.
5. Reload OpenClaw config (restart systemd user service).
6. Observe first cycle (5 min for F-R1, 30 min for F-R6) — verify `monitor_snapshots` rows accumulate, Telegram messages land.

**Rollback**: remove the 8 cron jobs from `openclaw.json`, delete `~/.openclaw/agents/hormi-mantenimiento/` tree, `DROP TABLE monitor_snapshots`, revert `openclaw.json workspace` pointer. No production data is touched by the watchdog — it only reads.

## Open Questions

- [ ] Telegram chatId value (resolve during apply)
- [ ] Whether an existing CRON framework (e.g., pg_cron) is available in PostgreSQL for the 7-day cleanup job; if not, document a manual cleanup cron or a dedicated OpenClaw shell cron job
- [ ] Exact `systemPromptFiles` field name in OpenCLaw agent config (assumed based on hormi-atencion pattern — confirm in apply)
