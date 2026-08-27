
INSERT INTO commercial_conditions (code, title, condition_type, body, applies_to, is_active)
VALUES
  ('medios-pago', 'Medios de Pago', 'payment',
   'Aceptamos transferencia bancaria, tarjetas de debito, tarjetas de credito, efectivo y Orden de Compra (B2B). Consulta por medios especificos segun tu tipo de cliente y modalidad.',
   '{}'::jsonb, true),

  ('transferencia-bancaria', 'Transferencia Bancaria', 'payment',
   'Datos bancarios para transferencia: Cuenta Corriente Hormiglass. El deposito debe ser validado por Finanzas antes de confirmar el pedido. No despachamos ni entregamos sin validacion de pago real.',
   '{}'::jsonb, true),

  ('garantia-productos', 'Garantía de Productos', 'warranty',
   'Todos nuestros productos de hormigon tienen garantia de 12 meses contra defectos de fabricacion. La garantia no cubre mal uso, instalacion incorrecta, danos por terceros ni desgaste natural por uso o intemperie. Para hacer efectiva la garantia, contacta a postventa con tu numero de venta, fotos y descripcion del problema.',
   '{}'::jsonb, true),

  ('despacho-domicilio', 'Despacho a Domicilio', 'delivery',
   'Realizamos despachos a domicilio segun comuna y volumen del pedido. El valor del despacho es variable segun destino, cantidad y tipo de producto. Para cotizar el despacho necesitamos: comuna, direccion, producto, cantidad y fecha estimada. Tambien consulta por restricciones de acceso (camion, calles angostas, horarios).',
   '{}'::jsonb, true),

  ('comunas-atendidas', 'Comunas con Despacho', 'delivery',
   'Atendemos la Region Metropolitana y regiones. La cobertura depende del volumen y producto. Consulta con tu ejecutiva la factibilidad de despacho a tu comuna.',
   '{}'::jsonb, true),

  ('servicio-instalacion', 'Servicio de Instalación', 'installation',
   'Ofrecemos servicio de instalacion profesional para nuestros productos. La instalacion incluye mano de obra especializada. No incluye retiro de escombros ni material antiguo, salvo que se cotice aparte. Para presupuestar instalacion necesitamos: producto, metros, comuna, tipo de terreno, acceso, fotos del lugar y fecha tentativa.',
   '{}'::jsonb, true),

  ('retiro-escombros', 'Retiro de Escombros', 'installation',
   'El retiro de escombros es un servicio adicional que debe cotizarse por separado. Aplica principalmente en instalaciones que requieren remocion de material antiguo. El valor depende del volumen estimado. Consulta con tu ejecutiva para incluirlo en la cotizacion.',
   '{}'::jsonb, true),

  ('vigencia-cotizacion', 'Vigencia de Cotización', 'quote',
   'Las cotizaciones tienen una vigencia de 15 dias habiles desde su emision. Despues de ese plazo, los valores pueden estar sujetos a reajuste segun variacion de costos, disponibilidad de stock o cambios en condiciones comerciales.',
   '{}'::jsonb, true)

ON CONFLICT (code) DO UPDATE
SET
  title = EXCLUDED.title,
  condition_type = EXCLUDED.condition_type,
  body = EXCLUDED.body,
  applies_to = EXCLUDED.applies_to,
  is_active = EXCLUDED.is_active,
  updated_at = NOW();
