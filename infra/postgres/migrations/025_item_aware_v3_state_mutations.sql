-- Item-aware `apply_v3_state_mutations`. Superset of the 022 body: a batch
-- that only ever touches quote-level fields (never `product`, `quantity` or
-- `measurements`, and the snapshot never already carries `line_items`) is
-- byte-identical to the old function. Once an item field is touched, or the
-- snapshot already carries `line_items`, the function also maintains the
-- item-aware `line_items[]` model and its flat projection mirror.
--
-- Down migration: infra/postgres/rollback/025_item_aware_v3_state_mutations.down.sql
-- restores the exact 022 body (D8 — kept outside migrations/ so
-- reset-test-db.mjs never applies it as a forward migration).
--
-- Steps (design.md "SQL (025_item_aware_v3_state_mutations.sql)"):
--   1. D3 reconcile: a legacy writer that ran after a rollback overwrites the
--      primary item with the flat values.
--   2. Flat non-item fields keep jsonb_set. A flat mutation on `line_items`,
--      `line_items_projection` or `line_items_schema` raises an error, same
--      as an underscore-prefixed field does today.
--   3. An item field without item_id targets the primary item and
--      materializes li_0 from the flat values.
--   4. An item field with item_id upserts that id: update in place, or
--      append when the id is absent.
--   5. remove_item removes the id, no-op-safe when the id is absent.
--   6. Raises an error above 10 items.
--   7. Recomputes the projection.
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
    IF v_field IN ('product', 'quantity', 'measurements') THEN
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
    IF v_field NOT IN ('product', 'quantity', 'measurements') THEN
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
