-- Rollback of migration 036 (business-hours FAQ): restore the seeded answer.
-- Apply atomically: psql -v ON_ERROR_STOP=1 -1 -f <this file>.

UPDATE faq_entries
SET question = '¿Atienden sábados?',
    answer = 'Nuestro horario de atencion es de lunes a viernes en horario comercial. Los sabados, domingos y festivos no tenemos atencion presencial, pero puedes dejar tu consulta por WhatsApp y te responderemos el siguiente dia habil.',
    tags = ARRAY['horario', 'sabado', 'finde', 'fin de semana', 'atencion']
WHERE question = '¿Cuál es el horario de atención?'
  AND deleted_at IS NULL;
