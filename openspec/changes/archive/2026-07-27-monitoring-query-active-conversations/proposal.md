# Proposal: Monitoring Query for Active Conversations

## Intent

Operators and support staff lack a daily-readiness view of active WhatsApp conversations. Today there is no single SQL query that shows which conversations are waiting, handed to sales, inactive, or in error — along with lead context, seller assignment, and idle time. This change creates a reusable monitoring query to close that gap.

## Scope

### In Scope
- One SQL file at `db/queries/ops/monitor-active-conversations.sql`
- Covers all conversations except `closed` status
- Sections: active/waiting, handed to sales, inactive/error
- Idle time calculation (hours since `last_message_at`)
- Lead status, service/city/requirement, assigned seller
- Ordered by idle time descending (oldest attention-needy first)

### Out of Scope
- No n8n workflow or application changes
- No dashboard, UI, or alerting
- No automation or scheduled execution

## Capabilities

### New Capabilities
None — this is an operational query, not a spec-level behavior change.

### Modified Capabilities
None — no existing spec changes.

## Approach

Single-file `.sql` query following the existing pattern in `db/queries/ops/clickup-readiness/`. Use CTEs (`WITH`) to separate logical sections, calculate idle time via `EXTRACT(EPOCH FROM NOW() - last_message_at)`, and join `leads`, `sellers`, and status catalogs for context. Header comment documents purpose, usage, and example CLI invocation.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `db/queries/ops/monitor-active-conversations.sql` | New | Monitoring query file |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Query performance on large message tables | Low | Use indexed columns only (`conversations.last_message_at`, `messages.conversation_id`) |
| Missing edge case statuses | Low | Use `WHERE cs.code != 'closed'` — captures all active statuses inclusively |

## Rollback Plan

Delete the single file. No data or behavior is modified.

## Dependencies

None.

## Success Criteria

- [ ] Query executes against `crm_whatsapp_app` without errors
- [ ] Returns conversations in all expected statuses except `closed`
- [ ] Idle time calculation is correct (positive hours, sensible values)
- [ ] Header documents usage example with `docker compose exec`
