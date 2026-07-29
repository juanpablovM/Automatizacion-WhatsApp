\if :{?instance_name}
\else
\echo 'ERROR: instance_name psql variable is required'
\quit
\endif

SELECT set_config('app.default_instance_name', :'instance_name', FALSE);

DO $$
DECLARE
  v_instance_name TEXT := NULLIF(current_setting('app.default_instance_name'), '');
  v_active_count INTEGER;
  v_unmapped_count INTEGER;
  v_number_id BIGINT;
BEGIN
  IF v_instance_name IS NULL THEN
    RAISE EXCEPTION 'EVOLUTION_DEFAULT_INSTANCE is empty';
  END IF;

  IF EXISTS (
    SELECT 1 FROM whatsapp_numbers
    WHERE deleted_at IS NULL AND is_active = TRUE AND instance_name = v_instance_name
  ) THEN
    RETURN;
  END IF;

  SELECT count(*), count(*) FILTER (WHERE instance_name IS NULL), min(id)
  INTO v_active_count, v_unmapped_count, v_number_id
  FROM whatsapp_numbers
  WHERE deleted_at IS NULL AND is_active = TRUE;

  IF v_active_count = 1 AND v_unmapped_count = 1 THEN
    UPDATE whatsapp_numbers
    SET instance_name = v_instance_name, updated_at = NOW()
    WHERE id = v_number_id;

    INSERT INTO audit_logs (
      event_name, entity_type, entity_id, actor_type, actor_id, result, metadata
    )
    VALUES (
      'whatsapp_instance_bound', 'whatsapp_number', v_number_id,
      'system', 'sync_n8n_workflows', 'success',
      jsonb_build_object(
        'instance_name', v_instance_name,
        'rule', 'sole_active_unmapped_number'
      )
    );
    RETURN;
  END IF;

  RAISE EXCEPTION
    'Cannot map EVOLUTION_DEFAULT_INSTANCE: active_numbers=%, unmapped_active_numbers=%',
    v_active_count, v_unmapped_count;
END;
$$;
