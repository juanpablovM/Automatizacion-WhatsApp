# Tasks: Monitoring Query for Active Conversations

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~80-100 (1 new file) |
| 400-line budget risk | Low |
| Chained PRs recommended | No |
| Suggested split | Single PR |
| Delivery strategy | ask-always |
| Chain strategy | size-exception |

Decision needed before apply: No
Chained PRs recommended: No
Chain strategy: size-exception
400-line budget risk: Low

## Phase 1: Write Query

- [ ] 1.1 Create `db/queries/ops/monitor-active-conversations.sql` with header comment, purpose, and usage example
- [ ] 1.2 Implement CTE `active_waiting` — conversations with status `active` or `waiting_user`, joined with lead/seller context, ordered by idle time descending
- [ ] 1.3 Implement CTE `handed_to_sales` — conversations with status `handed_to_sales`, same context columns, ordered by idle time descending
- [ ] 1.4 Implement CTE `inactive_error` — conversations with status `inactive_timeout` or `error`, ordered by idle time descending
- [ ] 1.5 Implement final UNION ALL with `section` label column, adding `message_count` subquery from messages table

## Phase 2: Verify

- [ ] 2.1 Dry-run the query against local `crm_whatsapp_app` database via `docker compose exec`
- [ ] 2.2 Verify each section returns the expected statuses and no `closed` conversations appear
- [ ] 2.3 Verify idle time values are positive and sensible
- [ ] 2.4 Verify lead-less conversations show NULL lead columns (not excluded)
