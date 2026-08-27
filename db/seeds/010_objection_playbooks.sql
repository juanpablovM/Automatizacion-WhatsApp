
INSERT INTO objection_playbooks (objection_type, customer_signal, recommended_response, escalation_rule, priority, is_active)
VALUES
  ('price', 'esta caro, muy caro, mucho, sale muy caro, carisimo',
   'Entiendo. Es normal comparar. En estos proyectos lo importante es revisar el costo total: producto, espesor, despacho, instalacion, plazo, garantia y respaldo. A veces una opcion mas barata no incluye todo o puede terminar costando mas si despues hay que corregir.',
   'Si el cliente insiste en descuento sin evaluacion, derivar a ejecutiva con nota "solicita descuento".', 10, true),

  ('competitor', 'en otro lado mas barato, en otra parte, competencia, en x sitio, alla cuesta menos',
   'Perfecto que compares. Solo asegurate de revisar si ambas cotizaciones incluyen lo mismo: material, medidas, espesor, despacho, instalacion, retiro de escombros, plazo y garantia. Si quieres, te ayudo a ordenar la informacion para que una ejecutiva pueda orientarte mejor.',
   'No igualar precio automaticamente. Si cliente insiste, derivar a ejecutiva con detalle de la competencia.', 9, true),

  ('thinking', 'lo voy a pensar, lo veo, lo reviso, lo consulto, lo hablo, mas adelante, despues',
   'Esta bien. Para ayudarte a decidir, ¿que punto te falta resolver: precio, plazo, producto, instalacion o confianza?',
   'Si cliente no responde, programar seguimiento dia 1, 3, 7.', 7, true),

  ('urgency', 'necesito rapido, urgencia, para ayer, lo mas pronto, lo antes posible, se puede rapido',
   'Entiendo. Para revisar factibilidad necesitamos comuna, producto, cantidad y si es retiro, despacho o instalacion. Prefiero ayudarte a confirmar un plazo realista antes de prometer algo que pueda fallar. Con esos datos te derivamos para evaluar tiempos.',
   'Si urgencia alta y Lead A o instalacion, derivacion prioritaria a ejecutiva.', 8, true),

  ('price', 'solo quiero precio, solo precio, dame precio, cuanto sale no mas',
   'Te entiendo. Para darte un precio correcto necesito al menos producto, cantidad aproximada, comuna y modalidad. No es lo mismo solo material que despacho o instalacion. Con esos datos puedo orientarte mejor o derivarte para una cotizacion precisa.',
   'Si cliente insiste solo en precio directo, entregar precio referencial del catalogo si existe y sugerir derivacion a ejecutiva.', 6, true)

ON CONFLICT DO NOTHING;
