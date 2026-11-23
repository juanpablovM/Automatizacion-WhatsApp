-- Rollback of migration 043 (conversation continuation). Drops the helper,
-- the index and the column. The links recorded while 043 was live are lost;
-- message.new events already enqueued through them keep their conversation id.
-- Restore the pre-043 Fix V3 Route, Persist Conversation State and CRM
-- dispatcher queries first: they reference the column and the function.
-- Apply atomically: psql -v ON_ERROR_STOP=1 -f <this file>.

BEGIN;
SET LOCAL lock_timeout = '5s';

DROP FUNCTION IF EXISTS conversation_continuation_target(BIGINT, TEXT);
DROP INDEX IF EXISTS idx_conversations_continues_conversation_id;
ALTER TABLE conversations DROP COLUMN IF EXISTS continues_conversation_id;

COMMIT;
