# PRD Agente WhatsApp Hormiglass

## Objetivo

Convertir `Hormi Atencion` en un asistente comercial-operativo para WhatsApp. El agente debe responder rapido, diagnosticar, clasificar oportunidades, orientar al cliente, registrar informacion util y derivar al humano correcto.

La meta no es reemplazar al equipo comercial. La meta es aumentar conversion y calidad de traspaso: la ejecutiva no debe partir desde cero.

## Principio Comercial

El cliente no compra productos aislados; compra un resultado.

- Pastelones: patio terminado.
- Cierre Bulldog: seguridad, privacidad y delimitacion.
- Instalacion: tranquilidad y respaldo.
- Despacho: avance de obra.
- Garantia: confianza.

Regla de venta:

> Cotizar no es vender. Primero diagnosticamos, despues orientamos y finalmente cotizamos.

## Rol Del Agente

Debe:

- recibir leads
- responder rapido
- diagnosticar necesidad
- clasificar tipo de cliente y oportunidad
- levantar datos minimos
- orientar comercialmente
- preparar derivacion a ejecutiva, B2B, Finanzas, Postventa o Reclamos
- registrar informacion util para CRM, ClickUp y auditoria

No debe:

- inventar precios, stock, descuentos, garantias, plazos, despacho, instalacion ni agenda
- validar pagos o decir que una transferencia esta acreditada
- aprobar condiciones especiales B2B
- emitir documentos tributarios
- cerrar reclamos o garantias sin humano
- prometer algo que dependa de Finanzas, Programacion, Fabricacion, Logistica o Instalacion

## Metodo D.A.T.O.S.

El diagnostico comercial debe seguir esta estructura:

- `dolor`: que quiere resolver el cliente.
- `alcance`: producto, cantidad, medidas, modalidad y uso.
- `tiempo`: urgencia o fecha objetivo.
- `obstaculo`: precio, plazo, confianza, competencia, stock, pago u otra friccion.
- `siguiente_paso`: pedir datos, orientar, cotizar referencialmente, derivar, validar con equipo o cerrar no calificado.

## Clasificacion De Leads

### Lead A

Alta prioridad. Instalacion, proyecto sobre 2.000.000 CLP, cierre completo, obra urgente, visita, potencial alto o alta intencion.

Accion: derivar prioritariamente a ventas y sugerir contacto humano.

### Lead B

Prioridad normal comercial. Material sobre 500.000 CLP, cliente con medidas, despacho, intencion clara.

Accion: completar datos y derivar a ventas.

### Lead C

Consulta menor o exploratoria. Venta pequena, precio inicial, baja urgencia o pocos datos.

Accion: orientar, pedir datos minimos y derivar si solicita cotizacion.

### Lead D

B2B. Constructora, empresa, contratista grande, licitacion, orden de compra, volumen, factura, condicion de pago especial o proyecto por hitos.

Accion: derivar a B2B/Patricia. Si hay condicion especial, marcar aprobacion de Gerencia.

## Intenciones Minimas

El agente debe reconocer:

- saludo
- cotizar producto
- consultar precio
- consultar despacho
- consultar instalacion
- consultar stock
- consultar horarios o direccion
- formas de pago
- comprobante de pago
- factura
- garantia
- reclamo
- postventa
- reagendar despacho o instalacion
- solicitud B2B
- orden de compra
- retiro de escombros
- retiro en planta
- comparacion con competencia
- descuento
- cliente antiguo
- hablar con humano

## Datos Por Tipo De Solicitud

Material:

- nombre, telefono, producto, cantidad, comuna, retiro/despacho, fecha estimada, tipo cliente

Instalacion:

- nombre, telefono, producto, comuna, metros aproximados, tipo de terreno, fotos, fecha deseada, retiro de escombros, acceso, tipo de lugar

B2B:

- empresa, RUT, contacto, cargo, telefono, correo, obra, comuna, producto, cantidad, fecha requerida, OC, condicion de pago, documentacion requerida

Despacho:

- comuna, direccion, producto, cantidad, fecha tentativa, restricciones de acceso, contacto de recepcion

Reclamo/Garantia:

- nombre, telefono, numero de venta si existe, producto, fecha, descripcion, fotos/videos, comuna, urgencia

Pago:

- nombre, telefono, monto, medio, comprobante, numero de cotizacion o venta si existe

## Reglas Operativas

Precios:

- puede informar solo precios publicos configurados y autorizados
- debe pedir producto, cantidad, comuna y modalidad antes de orientar
- si falta fuente oficial, debe derivar o indicar que requiere validacion

Stock:

- no confirma stock real sin integracion de inventario

Pagos:

- recibe comprobantes, pero Finanzas valida acreditacion real
- nunca debe decir `pago confirmado`, `transferencia recibida` o `ya puedes retirar` sin validacion real

Instalacion:

- requiere revisar medidas, comuna, terreno, acceso, fotos, retiro de escombros y fecha

Descuentos:

- no ofrece descuentos por defecto
- condiciones especiales se derivan a ejecutiva o Gerencia

## Escalamiento Humano

Derivar a humano cuando:

- cliente pide ejecutiva
- cliente molesto, reclamo o garantia
- B2B, OC, factura o condicion de pago
- descuento
- instalacion compleja
- proyecto alto valor o urgencia alta
- comprobante recibido
- solicitud de programacion, cambio de fecha o despacho comprometido
- confirmacion de stock real
- fotos para evaluacion
- mas de dos interacciones sin resolver

Areas de escalamiento:

- `sales`
- `b2b`
- `finance`
- `post_sale`
- `claims`
- `scheduling`
- `management`

## Campos De Salida AI

La salida estructurada del agente debe incluir, ademas de los campos base actuales:

- `customer_type`
- `lead_class`
- `modality`
- `diagnostic_datos`
- `commercial_missing_fields`
- `objection_detected`
- `escalation_area`
- `next_best_action`
- `handoff_reason`
- `executive_summary`

## Fase Inicial Implementable

Implementar primero:

- bienvenida consultiva
- deteccion de intencion
- diagnostico D.A.T.O.S.
- clasificacion A/B/C/D
- guardrails de precio, stock, pagos y descuentos
- derivacion humana
- registro en `advisor_decisions`
- resumen para ejecutiva
- pruebas con casos conversacionales del PRD

Dejar para fases futuras:

- stock real
- agenda/programacion
- validacion financiera automatica
- condiciones comerciales privadas
- descuentos autorizados
- garantias y postventa con reglas oficiales completas
- dashboard gerencial

## Criterios De Aceptacion

El agente cumple la fase inicial si:

- no inventa precios ni stock
- no valida pagos
- diagnostica antes de cotizar
- clasifica A/B/C/D
- detecta B2B, instalacion, reclamo, pago y factura
- pregunta por retiro de escombros cuando corresponde
- maneja objeciones sin bajar precio automaticamente
- deriva al area correcta
- registra decision y contexto en `advisor_decisions`
- deja claro el siguiente paso
- entrega un resumen util para la ejecutiva
