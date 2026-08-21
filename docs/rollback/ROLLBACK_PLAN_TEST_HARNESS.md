# Test Harness Recovery Procedure

## Scope

`tests/contract/` exercises the exported conversation fixture in
process. It is a **fixture-level contract suite**, not an end-to-end test: it
does not call an n8n webhook, PostgreSQL, or Evolution API.

The PostgreSQL migration job is a separate integration boundary. It creates an
ephemeral Compose database, applies the versioned migrations, rebuilds the
schema through `tests/scripts/reset-test-db.mjs`, and then destroys the volume.
It executes the temporal re-engagement boundary and concurrent follow-up replay
tests against that real PostgreSQL instance.

`scripts/ops/test-reengagement-n8n-e2e.sh` is the end-to-end acceptance gate. It
starts the disposable PostgreSQL, n8n, and mock Evolution services; imports the
synthetic PostgreSQL credential and manifest-resolved candidate workflows;
activates only `WA - Inbound Entry`; submits a reserved synthetic webhook; and
asserts the resulting conversation, inbox, outbound, follow-up, audit, provider,
and replay state.

Neither gate changes production, so a failure must never trigger a production
rollback, force-push, tag, or database mutation.

## Local reproduction

Run the fixture contract without infrastructure:

```bash
npm ci
npm run test:fixture-contract
```

Validate and rebuild the disposable PostgreSQL database:

```bash
npm run check:compose
docker compose -f docker-compose.test.yml up -d --wait postgres
npm run db:reset:test
npm run test:integration:postgres
docker compose -f docker-compose.test.yml down -v --remove-orphans
```

Run the real n8n acceptance gate independently:

```bash
npm run test:e2e:n8n
```

The E2E script uses `TEST_POSTGRES_PORT`, `TEST_N8N_PORT`, and
`TEST_MOCK_EVOLUTION_PORT` for its host bindings. It passes `/dev/null` as the
Compose env file, never reads the repository `.env`, uses only the reserved
synthetic number `15550001111`, and always removes its containers and volume.

The reset command drops and recreates only the `public` schema in the database
selected by `TEST_PGHOST`, `TEST_PGPORT`, `TEST_PGDATABASE`, `TEST_PGUSER`, and
`TEST_PGPASSWORD`. Its
defaults target the test Compose service on `localhost:5433`; do not override
them with production credentials.

## Failure handling

### Fixture contract failure

1. Preserve the Vitest output from the failed CI run.
2. Reproduce with `npm run test:fixture-contract` on the same commit.
3. Compare the assertion with the workflow fixture and embedded node code.
4. Do not call the failure an n8n or database regression until a test crosses
   those runtime boundaries.

### PostgreSQL migration or reset failure

1. Download the `postgres-test-logs` CI artifact.
2. Reproduce with the disposable Compose commands above.
3. Fix the migration or reset harness and rerun from a new empty volume.
4. Tear down the environment even after failure:

```bash
docker compose -f docker-compose.test.yml down -v --remove-orphans
```

### Real n8n E2E failure

1. Download the `reengagement-n8n-e2e-logs` CI artifact.
2. Reproduce with `npm run test:e2e:n8n` on the same commit.
3. Inspect `compose.log` and `compose-ps.txt` before changing an assertion.
4. Confirm the failure is inside the disposable project; never point the script
   at production credentials, ports, or services.

## Evidence and retention

CI uploads PostgreSQL logs when the migration job fails and full Compose logs
when the n8n E2E fails. Both artifacts are retained for seven days. The fixture
contract keeps its evidence in the Actions log. No database dump is required
because the database contains synthetic, disposable state and the volume is
removed after every run.

## E2E acceptance contract

The real E2E gate proves all of the following through runtime boundaries:

1. the production-aligned n8n image imports bootstrap definitions and then
   reimports manifest-resolved workflow links;
2. an inbound webhook for a 72-hour conversation preserves its conversation ID
   and enters `previous_context`;
3. the neutral outbound copy is persisted as sent and reaches mock Evolution;
4. the old follow-up is cancelled, exactly one new pending follow-up is created,
   and one policy audit is written; and
5. replaying the same `external_message_id` returns `duplicate: true` without
   adding messages, follow-ups, audits, or provider calls.

The fixture suite remains correctly classified as a contract test even though a
separate real E2E gate now exists.
