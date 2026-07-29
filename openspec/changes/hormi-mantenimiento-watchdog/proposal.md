# Proposal: Hormi Mantenimiento Watchdog

## Intent

The bot currently has rich operational data (`inbound_events`, `messages`,
`advisor_decisions`, `external_operations`, `conversations`, `leads`,
`audit_logs`) but **no proactive monitoring**: every diagnosis requires manual
`psql` inspection after a user complains. The change builds an always-on
watchdog agent — **Hormi Mantenimiento** — running on the existing OpenClaw
gateway, that periodically queries PostgreSQL, detects anomalies (stuck
outbounds, AI cascading failures, ClickUp sync crashes, broken round-robin,
stalled conversations) via SQL + LLM analysis, and reports to the operator's
1:1 Telegram chat. Critical failures must alert within ~1 minute; routine
health checks every 30 min.

## Context Verified (not assumed)

- OpenClaw `2026.7.1-2` running; config at `~/.openclaw/openclaw.json`.
- Agent `hormi-mantenimiento` already declared but **empty** (no workspace
  files, no tools, no schedules); `model: nvidia/nemotron-3-super-120b-a12b`;
  `workspace` currently mis-points to shared `/home/agentesai/.openclaw/workspace`
  (must be isolated like `hormi-atencion`).
- `openclaw cron` supports `--every`, `--cron`, `--agent`, `--command <shell>`
  (cheap shell jobs), `--message <text>` (agent jobs), `--trigger-script`
  (condition file), `--announce`, `--to <chatId>`. No cron jobs exist today.
- Telegram channel configured (`botToken` present, `groups.*.requireMention=true`).
- Safe status codes confirmed via seeds:
  `conversation_statuses` = `active|waiting_user|out_of_flow|handed_to_sales|escalation_required|inactive_timeout|closed|error`;
  `lead_statuses` = `draft|qualified_partial|qualified_complete|created_in_clickup|assigned|notified|closed|error`.
- SDD mode = **hybrid** (Engram + OpenSpec); `strict_tdd: true`.
- Antecedent: archived change `monitoring-query-active-conversations` produced
  `db/queries/ops/monitor-active-conversations.sql` — this watchdog **reuses**
  that query for the conversations check instead of duplicating.

## Scope

### In Scope
- `IDENTITY.md`, `INSTRUCTIONS.md` for the agent (Spanish copy, Telegram-ready).
- Fix `workspace` path to isolated `/home/agentesai/.openclaw/agents/hormi-mantenimiento/workspace`.
- Embedded SQL for 7 checks (inline in `INSTRUCTIONS.md`, not separate files).
- New table `monitor_snapshots` in `crm_whatsapp_app` (auditable history).
- JSON state file for fast diff between runs (workspace-local).
- ~5 OpenClaw cron jobs (5/15/30/60-min routine + 1-min critical trigger).
- 1-min critical trigger script (cheap shell → SQL condition → wake agent only on anomaly).

### Out of Scope
- Self-healing actions (agent observes + alerts only; no DB writes, no ClickUp calls, no n8n triggers).
- Dashboards or external UIs beyond Telegram messages.
- Model override per cron job (user chose: keep agent's default model for all checks).
- Replacing/reworking existing `monitor-active-conversations.sql` (reuse, don't fork).

## Capabilities

> Contract with sdd-spec.

### New Capabilities
- `hormi-mantenimiento-watchdog`: behavior of the watchdog agent — what it
  queries, how it detects anomalies, how it reports to Telegram, how it keeps
  state between runs, and its critical-trigger contract (latency ≤ ~1 min).

### Modified Capabilities
None — no existing spec is changed at requirement level.

## Architecture

```
OpenClaw gateway (24/7)
   │
   ├─ cron: every 5/15/30/60 min → agent job (model: nemotron-120b)
   │     │   hormi-mantenimiento reads INSTRUCTIONS.md → runs embedded SQL
   │     │   → psql against crm_whatsapp_app (docker compose exec -T postgres)
   │     │   → compares to last snapshot (workspace JSON + monitor_snapshots table)
   │     │   → LLM analysis → Telegram message → announce to operator 1:1
   │     │
   │     └─ cron: every 1 min → shell job (NO agent, NO model)
   │           │   cheap .sh: psql -c "<critical-condition SQL>"
   │           │   if condition true → `openclaw agent --message "CRITICAL: ..."` wake
   │           │   else → exit silently (zero tokens spent)
```

- **Gateway systemd**: already running 24/7 (out of this change's scope).
- **PostgreSQL access**: `docker compose --env-file .env exec -T postgres
  psql -U postgres -d crm_whatsapp_app` (matches existing `db/queries/ops`
  usage comment).
- **Telegram delivery**: `--announce --to <operator-chatId>` on each agent cron.
- **State strategy (dual)**:
  - Fast diff: `~/.openclaw/agents/hormi-mantenimiento/workspace/state/last-snapshot.json`
    (prev run metrics; in-memory-fast, lossy on crash).
  - Auditable history: `monitor_snapshots` table (append-only, one row per
    check/run, with payload JSONB + verdict). Report "what changed" reads
    the previous row by `check_name + created_at DESC LIMIT 1`.

## Monitoring Checks

| # | Check | Cadence | Detects | Detection mode |
|---|-------|---------|---------|----------------|
| 1 | Stuck Messages | 5 min | Outbounds `delivery_status='queued'` > 5 min | routine cron |
| 2 | AI Failing | 15 min | Multiple `advisor_decisions.validation_result IN ('fallback','error')`; `confidence < 0.5` cluster | routine cron |
| 3 | ClickUp Down | 15 min | `external_operations.status='failed'` chain (≥3 trailing) | routine cron |
| 4 | Unassigned Leads | 15 min | Leads past creation with `assigned_seller_id IS NULL` while active sellers exist (round-robin broken) | routine cron |
| 5 | Stalled Conversations | 60 min | `last_message_at < NOW()-24h` AND status `error`/`escalation_required`; reuse `monitor-active-conversations.sql` shape | routine cron |
| 6 | General Health | 30 min | Message volume in/out last 30 min, error count, advisor confidence trend | routine cron |
| 7 | Critical Alerts | 1 min | (a) AI fallback/error cascade ≥5 in 10 min, (b) ClickUp down chain, (c) 0 `inbound_events` in 30 min | **shell trigger** → wake agent only on hit |

Exact SQL per check lives in the **spec** (delta scenarios) and is embedded
inline in `INSTRUCTIONS.md` at apply time. Umbrales and "what changed vs last
run" logic derived from `monitor_snapshots.prev` comparison.

## Report Format (Telegram, Spanish)

Every routine report must include:
- **Estado**: OK / WARN / CRITICAL with emoji (🟢/🟡/🔴).
- **Qué cambió**: delta vs last snapshot (counts, trends, new anomalies).
- **Recomendación**: actionable next step if WARN/CRITICAL, else omit.
- Markdown simple (Telegram-compatible: `*bold*`, `_italic_`, ``` code ```).

Critical alerts prefix 🚨 and are NOTORIOUS (multi-line, severity first).

Example sketch (illustrative, not normative):
```
🟡 *Salud General — 30 min*
InOut: 42↑ (vs 38 prev) | Errores n8n: 1↓
Confianza IA promedio: 0.82↓ (prev 0.88)
*Cambió*: bajó confianza promedio en últimos 15 min.
*Recomendación*: revisar advisor_decisions recientes.
```

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `~/.openclaw/openclaw.json` | Modified | Fix `hormi-mantenimiento.workspace` → isolated; add `tools` allow-list (`exec`, `read`, `write`) |
| `~/.openclaw/agents/hormi-mantenimiento/workspace/IDENTITY.md` | New | Agent identity (Spanish) |
| `~/.openclaw/agents/hormi-mantenimiento/workspace/INSTRUCTIONS.md` | New | Operation manual with 7 embedded SQL checks, thresholds, report templates |
| `~/.openclaw/agents/hormi-mantenimiento/workspace/state/last-snapshot.json` | New | Fast-diff state (gitignored locally) |
| `~/.openclaw/agents/hormi-mantenimiento/workspace/scripts/critical-trigger.sh` | New | 1-min cheap shell: SQL condition → wake agent only on hit |
| `infra/postgres/migrations/009_monitor_snapshots.sql` | New | Append-only `monitor_snapshots(check_name, severity, payload JSONB, verdict, created_at)` |
| `openspec/specs/hormi-mantenimiento-watchdog/spec.md` | New (via delta) | Spec: requirements + Given/When/Then scenarios |
| OpenClaw cron registry | Modified | ~5 new jobs via `openclaw cron add --agent hormi-mantenimiento ...` |

Note: per user decision #5, SQL is **embedded inline** in `INSTRUCTIONS.md`,
not separate files under `db/queries/ops/openclaw/`. That folder is NOT created.

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| LLM cost: every routine run wakes nemotron-120b (no model override chosen) | Med | Routine runs are 4 cadences; critical trigger only wakes on hit; thresholds prune silent runs |
| 1-min trigger latency vs requirement "<1 min detection" | Med | Shell job ~instant; agent wake async — total ~30-60s on hit. Document realistic SLA, not "instant" |
| OpenClaw gateway down → silent failures (no watchdog of the watchdog) | Low | Critical trigger script can `openclaw doctor` and report if gateway unreachable; document as known limitation |
| `psql` from outside container vs `docker compose exec` | Low | Standardize on `docker compose exec -T postgres psql ...` (matches existing ops scripts) |
| `monitor_snapshots` grow unbounded | Low | Append-only; add retention & periodic purge task (defer to post-launch) |
| Telegram `requireMention:true` for groups blocks 1:1 announce | Low | 1:1 chat has no mention requirement; verify `--to` chatId for operator's DM |
| Agent runs expensive SQL on hot tables | Med | All checks use indexed FK/timestamp columns (`created_at`, `last_message_at`); spec enforces `EXPLAIN` budget per query |
| Embedded SQL drifts from schema migrations | Med | Spec scenarios re-verify column existence at apply time; CI-style check in `verify` |

## Rollback Plan

1. Disable/delete all cron jobs for the agent:
   `openclaw cron list` → `openclaw cron rm <id>` for each `--agent hormi-mantenimiento` job.
2. Remove agent workspace files:
   `rm -rf ~/.openclaw/agents/hormi-mantenimiento/workspace/{IDENTITY.md,INSTRUCTIONS.md,scripts,state}`.
3. Revert `openclaw.json` entries for `hormi-mantenimiento` to the pre-change
   state (empty agent, shared workspace).
4. Drop `monitor_snapshots` table:
   `DROP TABLE IF EXISTS monitor_snapshots;` — no business data affected.
5. Delete `009_monitor_snapshots.sql` migration file.

No n8n workflows, business tables, or app code are touched — rollback is
isolated to OpenClaw config + one optional table.

## Dependencies

- OpenClaw `2026.7.1-2` gateway running 24/7 (already in place).
- Telegram bot token present in `openclaw.json` (already in place).
- Operator's 1:1 Telegram `chatId` (to be supplied at apply time for `--to`).
- Docker Compose stack up (`postgres` reachable via `docker compose exec`).
- `crm_whatsapp_app` populated by existing n8n workflows (in place).

## Success Criteria

- [ ] Agent reports to operator Telegram on a healthy system at the 30-min
      cadence without manual trigger, for ≥3 consecutive runs.
- [ ] On injected anomaly (queued outbound >5 min, or forced `validation_result='error'` cluster), the matching check raises a WARN/CRITICAL line within its cadence.
- [ ] Critical trigger wakes the agent within ~1 minute when the critical SQL
      condition is true, and stays silent (zero agent invocations, zero model
      tokens) when it is false — verified over ≥60 silent minutes.
- [ ] Each routine report includes Estado +Qué cambió vs last snapshot
      (non-empty on any change) + Recomendación only when WARN/CRITICAL.
- [ ] `monitor_snapshots` rows accumulate one-per-check-per-run and the diff
      logic correctly references the previous row by `check_name`.
- [ ] No false-positive spam: on a clean system, the 5/15/60-min checks emit
      a single OK or stay silent per design decision.
- [ ] Rollback verified: removing all created artifacts leaves the bot's
      existing behavior unchanged.
- [ ] Spec scenarios in `hormi-mantenimiento-watchdog/spec.md` pass during
      `verify` phase (`sh scripts/ops/test-ai-assistant-local.sh && sh scripts/ops/test-conversation-regression-local.sh` + watchdog-specific tests).
