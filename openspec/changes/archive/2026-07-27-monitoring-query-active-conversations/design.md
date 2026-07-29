# Design: Monitoring Query for Active Conversations

## Technical Approach

Single-file read-only SQL query using CTEs to separate monitoring sections, following the existing pattern in `db/queries/ops/clickup-readiness/`. The query calculates idle time via `EXTRACT(EPOCH FROM ...)` and joins conversations with leads, sellers, and status catalogs for operational context.

## Architecture Decisions

### Decision: CTE structure over UNION ALL

**Choice**: Multiple named CTEs with a final UNION ALL — one CTE per monitoring category (active/waiting, handed_to_sales, inactive/error) with a `section` label column.

**Alternatives considered**: Single SELECT with CASE filters; separate queries for each section.

**Rationale**: CTEs isolate section-specific WHERE clauses clearly, making the query maintainable and readable. The `section` label lets operators scan results quickly. UNION ALL preserves ordering within each section. Single SELECT with CASE filters would need repetitive CASE expressions for each section label.

### Decision: Idle time in hours with ROUND

**Choice**: `ROUND(EXTRACT(EPOCH FROM NOW() - c.last_message_at) / 3600, 1)` as `idle_hours`.

**Alternatives considered**: `INTERVAL` string representation; minutes-only.

**Rationale**: Hours with one decimal is the most scan-friendly format for operators. `ROUND(..., 1)` avoids floating-point noise (4.999999999 → 5.0).

### Decision: LEFT JOINs for leads and sellers

**Choice**: `LEFT JOIN` from conversations to leads to sellers — conversations are the primary entity, lead/seller context is optional.

**Alternatives considered**: INNER JOIN (requires lead); subquery expressions.

**Rationale**: Conversations may exist without leads (early stages), and leads may not be assigned. LEFT JOIN preserves visibility of orphaned conversations, which is valuable for operations.

## Data Flow

```
conversations ──┬──► conversation_statuses  (status label & code)
                ├──► leads                   (service, city, requirement)
                │     └──► lead_statuses     (status label)
                │     └──► sellers           (seller name)
                └──► messages (aggregate)    (message_count)
```

The query reads from these tables but writes nothing.

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `db/queries/ops/monitor-active-conversations.sql` | Create | Multi-section monitoring query with idle time and context |

## Interfaces / Contracts

The query expects:
- Database: `crm_whatsapp_app`
- Schema: `public`
- No parameters (standalone report query)
- Invocation via `docker compose exec -T postgres psql -U postgres -d crm_whatsapp_app -f <path>`

Return columns per section: `section`, `status_label`, `phone_number`, `last_message_at`, `idle_hours`, `lead_service`, `lead_city`, `lead_requirement`, `lead_status`, `seller_name`, `conversation_id`, `lead_id`.

## Testing Strategy

| Layer | What to Test | Approach |
|-------|-------------|----------|
| Verification | Dry-run the SQL | Manual execution against local DB with existing test data |

## Threat Matrix

N/A — no routing, shell, subprocess, VCS/PR automation, executable-file classification, or process-integration boundary.

## Migration / Rollout

No migration required. Single file addition, zero side effects.

## Open Questions

None.
