
INSERT INTO faq_entries (question, answer, tags, priority, is_active)
VALUES
  ('¿Cuánto cuesta el metro de cierre?',
   'El valor del metro de cierre depende del tipo de placa, altura, cantidad y si requieres instalacion. Tenemos placas de 50 cm, 60 cm, imitacion madera, piedra laja y reforzadas, con precios desde $10.500 hasta $34.300 segun el modelo. Para un valor exacto necesitamos: producto, cantidad, comuna y modalidad (solo material o instalado).',
   ARRAY['precio', 'cierre', 'metro', 'placa'], 10, true),

  ('¿Hacen instalación?',
   'Si, ofrecemos servicio de instalacion profesional. Para presupuestar necesitamos: producto, metros aproximados, comuna, tipo de terreno, acceso, fotos del lugar si tienes, fecha tentativa y si requiere retiro de escombros. Solicita una cotizacion con esos datos y te derivamos con una ejecutiva.',
   ARRAY['instalacion', 'instalar', 'colocar', 'mano de obra'], 9, true),

  ('¿Cuánto cobran por despacho?',
   'El valor del despacho depende de la comuna, cantidad y tipo de producto. Atendemos RM y regiones segun factibilidad. Para cotizar el despacho necesitamos: comuna, direccion aproximada, producto, cantidad y fecha estimada. Contacta a una ejecutiva para revisar tu caso.',
   ARRAY['despacho', 'envio', 'delivery', 'transporte', 'flete'], 8, true),

  ('¿Tienen stock?',
   'La disponibilidad de stock se confirma al momento de realizar el pedido. No podemos garantizar stock sin validacion del equipo. Te recomendamos dejar tus datos (producto, cantidad y comuna) para que una ejecutiva revise disponibilidad y te confirme antes de cerrar la venta.',
   ARRAY['stock', 'disponible', 'disponibilidad', 'inventario'], 7, true),

  ('¿A qué comunas despachan?',
   'Despachamos a la Region Metropolitana y a regiones, segun el volumen del pedido y la zona. La factibilidad de despacho se revisa caso a caso. Contacta a una ejecutiva con tu comuna y producto para confirmar.',
   ARRAY['comuna', 'despacho', 'cobertura', 'region', 'zona'], 6, true),

  ('¿Cómo puedo pagar?',
   'Aceptamos transferencia bancaria, tarjetas de debito, tarjetas de credito y efectivo. Para clientes B2B aceptamos Orden de Compra segun condiciones. Los pagos deben ser validados por Finanzas antes de confirmar el pedido. Consulta con tu ejecutiva los detalles segun tu tipo de cliente.',
   ARRAY['pago', 'forma de pago', 'transferencia', 'tarjeta', 'credito', 'debito'], 9, true),

  ('¿Cuál es la garantía?',
   'Nuestros productos tienen garantia de 12 meses contra defectos de fabricacion. No cubre mal uso, instalacion incorrecta ni desgaste natural. Para hacer efectiva la garantia necesitamos: numero de venta, fotos y descripcion del problema. Contacta a postventa para gestionarlo.',
   ARRAY['garantia', 'garantizado', 'defecto', 'problema'], 7, true),

  ('¿Tienen descuento por volumen?',
   'Las condiciones comerciales especiales y descuentos por volumen los revisa una ejecutiva segun el caso, producto, cantidad y vigencia de la cotizacion. No podemos ofrecer descuentos automaticos sin evaluacion. Te derivamos con una ejecutiva para revisar tu caso.',
   ARRAY['descuento', 'volumen', 'cantidad', 'mayorista', 'precio especial'], 6, true),

  ('¿Hacen factura?',
   'Si, emitimos factura para empresas y contribuyentes que la requieran. Necesitamos tus datos de facturacion: RUT, razon social, giro y direccion. Si es B2B, adicionalmente requerimos Orden de Compra si aplica. Contacta a una ejecutiva o al area de administracion para gestionarla.',
   ARRAY['factura', 'boleta', 'documento', 'tributario', 'DTE'], 5, true),

  ('¿Retiran escombros?',
   'El retiro de escombros es un servicio adicional que se cotiza aparte. Aplica principalmente cuando hay que remover material antiguo antes de instalar. Si tu proyecto requiere instalacion y retiro de escombros, informalo para incluirlo en la cotizacion.',
   ARRAY['escombro', 'retiro', 'limpieza', 'remocion', 'material antiguo'], 7, true),

  ('¿Cuál es la dirección de la planta?',
   'Nuestra planta esta ubicada en la Region Metropolitana. Para atencion presencial y retiro de productos, agendar una visita con tu ejecutiva es recomendable para asegurar disponibilidad y horario. Contactanos para coordinar.',
   ARRAY['direccion', 'planta', 'ubicacion', 'retiro', 'visita'], 4, true),

  ('¿Atienden sábados?',
   'Nuestro horario de atencion es de lunes a viernes en horario comercial. Los sabados, domingos y festivos no tenemos atencion presencial, pero puedes dejar tu consulta por WhatsApp y te responderemos el siguiente dia habil.',
   ARRAY['horario', 'sabado', 'finde', 'fin de semana', 'atencion'], 3, true)

ON CONFLICT DO NOTHING;
