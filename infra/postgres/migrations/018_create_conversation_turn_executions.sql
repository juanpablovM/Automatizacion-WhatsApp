-- Durable execution ledger for versioned conversational decisions.
-- Immutable policy/proposal/decision payloads remain in advisor_decisions;
-- this table records only lifecycle state and durable receipt references.

CREATE TABLE conversation_turn_executions (
  id BIGSERIAL PRIMARY KEY,
  inbound_event_id BIGINT NOT NULL REFERENCES inbound_events(id) ON DELETE RESTRICT,
  conversation_id BIGINT NOT NULL REFERENCES conversations(id) ON DELETE RESTRICT,
  advisor_decision_id BIGINT REFERENCES advisor_decisions(id) ON DELETE RESTRICT,
  decision_id TEXT,
  contract_version TEXT NOT NULL
    CHECK (contract_version IN ('v3')),
  route_mode TEXT NOT NULL
    CHECK (route_mode IN ('shadow', 'canary', 'enforce')),
  route_rule_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'routed'
    CHECK (state IN (
      'routed', 'prepared', 'effects_pending', 'ready_to_commit', 'committed',
      'delivery_pending', 'delivered', 'aborted', 'reconciliation_required'
    )),
  conversation_revision_expected BIGINT,
  expected_snapshot_digest TEXT,
  policy_digest TEXT,
  proposal_digest TEXT,
  decision_digest TEXT,
  delivery_key TEXT,
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  effect_receipt_refs JSONB NOT NULL DEFAULT '[]'::JSONB,
  state_receipt JSONB,
  delivery_message_id BIGINT REFERENCES messages(id) ON DELETE SET NULL,
  delivery_receipt_ref JSONB,
  last_error JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (inbound_event_id),
  UNIQUE (decision_id),
  UNIQUE (delivery_key),
  CHECK (jsonb_typeof(effect_receipt_refs) = 'array'),
  CHECK (decision_id IS NULL OR state <> 'routed'),
  CHECK (delivery_message_id IS NULL OR state IN ('delivery_pending', 'delivered', 'reconciliation_required'))
);

CREATE INDEX idx_conversation_turn_executions_conversation_state
ON conversation_turn_executions (conversation_id, state, id);

CREATE INDEX idx_conversation_turn_executions_reconciliation
ON conversation_turn_executions (updated_at, id)
WHERE state = 'reconciliation_required';

DROP TRIGGER IF EXISTS set_conversation_turn_executions_updated_at ON conversation_turn_executions;
CREATE TRIGGER set_conversation_turn_executions_updated_at
BEFORE UPDATE ON conversation_turn_executions
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
