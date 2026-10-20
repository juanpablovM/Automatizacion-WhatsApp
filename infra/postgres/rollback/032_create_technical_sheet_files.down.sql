-- Down migration for 032_create_technical_sheet_files.sql (task 3c.29).
--
-- Kept outside infra/postgres/migrations/ on purpose: tests/scripts/reset-test-db.mjs
-- applies every numbered file in that directory, and this file must never run
-- as a forward migration. Roll back the workflows first (the load query and the
-- outbound send read this table), then:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f infra/postgres/rollback/032_create_technical_sheet_files.down.sql
DROP TABLE IF EXISTS technical_sheet_files;
