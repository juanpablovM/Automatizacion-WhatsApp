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
  expected_snapshot JSONB,
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

CREATE UNIQUE INDEX uq_conversation_turn_executions_active_conversation
ON conversation_turn_executions (conversation_id)
WHERE state NOT IN ('delivered', 'aborted');

CREATE INDEX idx_conversation_turn_executions_reconciliation
ON conversation_turn_executions (updated_at, id)
WHERE state = 'reconciliation_required';

DROP TRIGGER IF EXISTS set_conversation_turn_executions_updated_at ON conversation_turn_executions;
CREATE TRIGGER set_conversation_turn_executions_updated_at
BEFORE UPDATE ON conversation_turn_executions
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE FUNCTION reject_authorized_v3_decision_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM conversation_turn_executions execution
    WHERE execution.advisor_decision_id = OLD.id
      AND execution.contract_version = 'v3'
  ) THEN
    RAISE EXCEPTION 'authorized v3 advisor decision is immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS reject_authorized_v3_decision_update ON advisor_decisions;
CREATE TRIGGER reject_authorized_v3_decision_update
BEFORE UPDATE ON advisor_decisions
FOR EACH ROW EXECUTE FUNCTION reject_authorized_v3_decision_mutation();

-- Apply only the mutation vocabulary authorized by validated_conversation_decision/v3.
-- Unknown operations fail the whole state-plus-outbox transaction.
CREATE OR REPLACE FUNCTION apply_v3_state_mutations(
  p_snapshot JSONB,
  p_mutations JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_result JSONB := COALESCE(p_snapshot, '{}'::JSONB);
  v_mutation JSONB;
  v_field TEXT;
BEGIN
  IF jsonb_typeof(COALESCE(p_mutations, '[]'::JSONB)) <> 'array' THEN
    RAISE EXCEPTION 'v3 mutations must be an array';
  END IF;

  FOR v_mutation IN SELECT value FROM jsonb_array_elements(COALESCE(p_mutations, '[]'::JSONB))
  LOOP
    v_field := NULLIF(v_mutation->>'field', '');
    IF v_field IS NULL OR v_field LIKE '\_%' ESCAPE '\' THEN
      RAISE EXCEPTION 'invalid v3 mutation field';
    END IF;
    IF v_mutation->>'operation' = 'set' AND v_mutation ? 'value' THEN
      v_result := jsonb_set(v_result, ARRAY[v_field], v_mutation->'value', TRUE);
    ELSIF v_mutation->>'operation' = 'remove' THEN
      v_result := v_result - v_field;
    ELSE
      RAISE EXCEPTION 'unsupported v3 mutation operation';
    END IF;
  END LOOP;
  RETURN v_result;
END;
$$;
