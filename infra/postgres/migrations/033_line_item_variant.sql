-- Task 3c.33 (M1): `variant` becomes an item field of `apply_v3_state_mutations`.
-- The v3.1 contract records the technical-sheet variant the customer chose
-- (for example "Solera zarpa Tipo A") with a `variant` state mutation scoped to
-- one item. Before this migration that mutation fell through to the
-- quote-level path and landed on the flat context, detached from its item.
--
-- The body is migration 025's, with 'variant' added to the two item-field
-- lists only: a variant mutation now touches the item-aware model and upserts
-- the field on its item (creating the item when the id is new). It is never
-- mirrored into the flat projection (product/quantity/measurements) and an
-- item carries the key only once it is set, so every row and every batch that
-- never sets a variant behaves exactly as under 025. The JS twin is
-- tests/fixtures/workflow-nodes/shared/v3-line-items.js, asserted against the
-- same case table (v3-line-items.cases.js) by the Postgres parity suite.
--
-- Down migration: infra/postgres/rollback/033_line_item_variant.down.sql
-- restores the exact 025 body (kept outside migrations/ so reset-test-db.mjs
-- never applies it as a forward migration).
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
  v_operation TEXT;
  v_item_id TEXT;
  v_touches_items BOOLEAN := FALSE;
  v_items JSONB[] := ARRAY[]::JSONB[];
  v_flat JSONB;
  v_stored JSONB;
  v_idx INT;
  v_found INT;
BEGIN
  IF jsonb_typeof(COALESCE(p_mutations, '[]'::JSONB)) <> 'array' THEN
    RAISE EXCEPTION 'v3 mutations must be an array';
  END IF;

  -- Pass 1: validate every mutation up front (same rule regardless of which
  -- path the batch ends up on) and detect whether the item-aware path
  -- applies: an item-field mutation, a remove_item, or a snapshot that is
  -- already item-aware.
  FOR v_mutation IN SELECT value FROM jsonb_array_elements(COALESCE(p_mutations, '[]'::JSONB))
  LOOP
    v_operation := v_mutation->>'operation';
    IF v_operation = 'remove_item' THEN
      v_touches_items := TRUE;
      CONTINUE;
    END IF;
    v_field := NULLIF(v_mutation->>'field', '');
    IF v_field IS NULL OR v_field LIKE '\_%' ESCAPE '\' THEN
      RAISE EXCEPTION 'invalid v3 mutation field';
    END IF;
    IF v_field IN ('line_items', 'line_items_projection', 'line_items_schema') THEN
      RAISE EXCEPTION 'invalid v3 mutation field';
    END IF;
    IF v_operation NOT IN ('set', 'replace') OR NOT (v_mutation ? 'projected_value') THEN
      RAISE EXCEPTION 'unsupported v3 mutation operation';
    END IF;
    IF v_field IN ('product', 'quantity', 'measurements', 'variant') THEN
      v_touches_items := TRUE;
    END IF;
  END LOOP;

  IF NOT v_touches_items AND NOT (v_result ? 'line_items') THEN
    -- Legacy-compatible path: byte-identical to the pre-item-aware function.
    FOR v_mutation IN SELECT value FROM jsonb_array_elements(COALESCE(p_mutations, '[]'::JSONB))
    LOOP
      v_result := jsonb_set(v_result, ARRAY[v_mutation->>'field'], v_mutation->'projected_value', TRUE);
    END LOOP;
    RETURN v_result;
  END IF;

  -- Item-aware path. Load the stored items, reconciling (D3) or
  -- materializing (step 3) the primary item first.
  IF jsonb_array_length(COALESCE(v_result->'line_items', '[]'::JSONB)) = 0 THEN
    IF (v_result ? 'product' AND v_result->'product' IS DISTINCT FROM 'null'::JSONB)
       OR (v_result ? 'quantity' AND v_result->'quantity' IS DISTINCT FROM 'null'::JSONB)
       OR (v_result ? 'measurements' AND v_result->'measurements' IS DISTINCT FROM 'null'::JSONB)
    THEN
      v_items := ARRAY[jsonb_build_object(
        'item_id', 'li_0',
        'product', COALESCE(v_result->'product', 'null'::JSONB),
        'quantity', COALESCE(v_result->'quantity', 'null'::JSONB),
        'measurements', COALESCE(v_result->'measurements', 'null'::JSONB),
        'catalog_ref', NULL::JSONB,
        'requested_label', NULL::JSONB
      )];
    END IF;
  ELSE
    SELECT array_agg(value) INTO v_items FROM jsonb_array_elements(v_result->'line_items');
    v_stored := COALESCE(v_result->'line_items_projection', '{}'::JSONB);
    v_flat := jsonb_build_object(
      'product', COALESCE(v_result->'product', 'null'::JSONB),
      'quantity', COALESCE(v_result->'quantity', 'null'::JSONB),
      'measurements', COALESCE(v_result->'measurements', 'null'::JSONB)
    );
    IF v_flat IS DISTINCT FROM jsonb_build_object(
      'product', COALESCE(v_stored->'product', 'null'::JSONB),
      'quantity', COALESCE(v_stored->'quantity', 'null'::JSONB),
      'measurements', COALESCE(v_stored->'measurements', 'null'::JSONB)
    ) THEN
      -- D3: a legacy writer ran after rollback; the flat values win for the
      -- primary (first) item.
      v_items[1] := v_items[1] || v_flat;
    END IF;
  END IF;

  -- Pass 2: apply this turn's mutations against the item-aware working set.
  FOR v_mutation IN SELECT value FROM jsonb_array_elements(COALESCE(p_mutations, '[]'::JSONB))
  LOOP
    v_operation := v_mutation->>'operation';
    IF v_operation = 'remove_item' THEN
      v_item_id := v_mutation->>'item_id';
      SELECT COALESCE(array_agg(entry), ARRAY[]::JSONB[]) INTO v_items
        FROM unnest(v_items) entry
        WHERE entry->>'item_id' IS DISTINCT FROM v_item_id;
      CONTINUE;
    END IF;
    v_field := v_mutation->>'field';
    IF v_field NOT IN ('product', 'quantity', 'measurements', 'variant') THEN
      v_result := jsonb_set(v_result, ARRAY[v_field], v_mutation->'projected_value', TRUE);
      CONTINUE;
    END IF;
    v_item_id := COALESCE(v_mutation->>'item_id', v_items[1]->>'item_id', 'li_0');
    v_found := NULL;
    FOR v_idx IN 1..COALESCE(array_length(v_items, 1), 0) LOOP
      IF v_items[v_idx]->>'item_id' = v_item_id THEN
        v_found := v_idx;
      END IF;
    END LOOP;
    IF v_found IS NULL THEN
      v_items := array_append(v_items, jsonb_build_object(
        'item_id', v_item_id, 'product', NULL, 'quantity', NULL, 'measurements', NULL,
        'catalog_ref', NULL, 'requested_label', NULL
      ));
      v_found := array_length(v_items, 1);
    END IF;
    v_items[v_found] := jsonb_set(v_items[v_found], ARRAY[v_field], v_mutation->'projected_value', TRUE);
  END LOOP;

  IF COALESCE(array_length(v_items, 1), 0) > 10 THEN
    RAISE EXCEPTION 'line_items_limit_exceeded';
  END IF;

  -- Recompute the flat projection mirror (deleted entirely once no item
  -- remains, never left as null).
  IF COALESCE(array_length(v_items, 1), 0) = 0 THEN
    v_result := v_result - 'product' - 'quantity' - 'measurements';
    v_result := jsonb_set(v_result, ARRAY['line_items'], '[]'::JSONB, TRUE);
    v_result := jsonb_set(v_result, ARRAY['line_items_projection'],
      jsonb_build_object('product', NULL, 'quantity', NULL, 'measurements', NULL), TRUE);
  ELSE
    v_result := jsonb_set(v_result, ARRAY['product'], COALESCE(v_items[1]->'product', 'null'::JSONB), TRUE);
    v_result := jsonb_set(v_result, ARRAY['quantity'], COALESCE(v_items[1]->'quantity', 'null'::JSONB), TRUE);
    v_result := jsonb_set(v_result, ARRAY['measurements'], COALESCE(v_items[1]->'measurements', 'null'::JSONB), TRUE);
    v_result := jsonb_set(v_result, ARRAY['line_items'],
      (SELECT jsonb_agg(entry) FROM unnest(v_items) entry), TRUE);
    v_result := jsonb_set(v_result, ARRAY['line_items_projection'], jsonb_build_object(
      'product', COALESCE(v_items[1]->'product', 'null'::JSONB),
      'quantity', COALESCE(v_items[1]->'quantity', 'null'::JSONB),
      'measurements', COALESCE(v_items[1]->'measurements', 'null'::JSONB)
    ), TRUE);
  END IF;
  v_result := jsonb_set(v_result, ARRAY['line_items_schema'], to_jsonb('line_items/v1'::TEXT), TRUE);

  RETURN v_result;
END;
$$;
