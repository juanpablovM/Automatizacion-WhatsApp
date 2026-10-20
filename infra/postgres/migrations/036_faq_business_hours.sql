-- Business-hours FAQ: state the hours published on hormiglass.cl.
--
-- The seeded answer said "lunes a viernes en horario comercial" and that
-- Saturdays were closed, so the bot told customers the opposite of the website,
-- which opens Saturday mornings. The row is matched by its seeded question and
-- rewritten in place; running it again changes nothing. The extra tags let the
-- commercial context find this FAQ for messages like "¿a qué hora abren?" or
-- "¿atienden el domingo?".

UPDATE faq_entries
SET question = '¿Cuál es el horario de atención?',
    answer = 'Atendemos de lunes a martes de 8:00 a 13:00 y de 14:00 a 18:00, de miércoles a viernes de 8:00 a 13:00 y de 14:00 a 17:00, y los sábados de 8:00 a 14:00. Domingos y festivos no atendemos, pero puedes dejar tu consulta por WhatsApp y te responderemos el siguiente día hábil.',
    tags = ARRAY['horario', 'sabado', 'finde', 'fin de semana', 'atencion', 'sábado', 'domingo', 'festivo', 'hora', 'abren', 'cierran']
WHERE question IN ('¿Atienden sábados?', '¿Cuál es el horario de atención?')
  AND deleted_at IS NULL;
