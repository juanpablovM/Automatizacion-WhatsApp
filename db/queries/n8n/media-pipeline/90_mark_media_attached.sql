-- =============================================================================
-- 90_mark_media_attached.sql — PUNTO DE EXTENSION ClickUp (CR-014) — PENDIENTE.
-- -----------------------------------------------------------------------------
-- NO implementado y NO llamado por ningun workflow: el adjunto real del
-- binario a la oportunidad ClickUp queda para la Unidad 4/6 (alcance ajustado
-- de la Unidad 5: EXCLUIDO). Este script existe SOLO como contrato documentado
-- de lo que hara esa integracion cuando exista:
--
--   1. marcar `attached_to` con la referencia ClickUp del task de la
--      oportunidad;
--   2. dejar `attach_pending=false`;
--   3. auditar el adjunto.
--
-- Contrato de invocacion futura:
--   SELECT mark_media_attached(:media_id::bigint, :clickup_ref::text);
--
-- Hasta entonces: `attached_to` queda NULL y `attach_pending=true` en las
-- medias descargadas. La suite de tests verifica que este script NO es
-- invocado por ningun workflow (gate de no-adjunto).
-- =============================================================================

CREATE OR REPLACE FUNCTION mark_media_attached(p_media_id BIGINT, p_clickup_ref TEXT)
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
  v_current TEXT;
  v_result TEXT;
BEGIN
  SELECT attached_to INTO v_current
  FROM media_attachments
  WHERE id = p_media_id AND deleted_at IS NULL;

  IF v_current IS NULL THEN
    UPDATE media_attachments
    SET attached_to = p_clickup_ref, attach_pending = FALSE
    WHERE id = p_media_id AND deleted_at IS NULL;

    INSERT INTO audit_logs (
      event_name, entity_type, entity_id, actor_type, actor_id,
      result, before_payload, after_payload, metadata
    ) VALUES (
      'media_attached', 'media_attachment', p_media_id, 'system',
      'clickup-attach-pending', 'attached',
      '{}'::jsonb,
      jsonb_build_object('attached_to', p_clickup_ref, 'attach_pending', FALSE),
      jsonb_build_object('feature', 'clickup_attach', 'status', 'pending_clickup_attach')
    );
    v_result := 'attached';
  ELSE
    v_result := 'already_attached';
  END IF;

  RETURN v_result;
END;
$$;