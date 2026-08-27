# Flujo de Leads

## Objetivo

Describir el flujo vigente desde el primer mensaje de WhatsApp hasta la creacion, asignacion y sincronizacion comercial del lead.

## Resumen

1. El cliente escribe por WhatsApp.
2. El sistema registra el mensaje y recupera la conversacion activa.
3. Gemini responde como asesor comercial: reconoce lo informado, orienta y formula una sola pregunta principal.
4. `n8n` valida la salida AI, actualiza `qualification_context` y conserva `pending_question_key`.
5. La siguiente pregunta se elige por valor comercial mediante D.A.T.O.S., no por un formulario rigido.
6. Cuando existen datos criticos y confirmacion explicita, se crea y asigna el lead.
7. ClickUp recibe el resumen ejecutivo, el diagnostico y la conversacion.
8. Solo despues de crear y asignar correctamente el lead se confirma la derivacion al cliente.

## Principios conversacionales

- responder primero al mensaje del cliente
- reconocer el dato recien entregado
- aportar orientacion comercial breve
- hacer como maximo una pregunta principal por turno
- no repetir datos ya conocidos
- interpretar `si/no` usando `pending_question_key`
- no reiniciar salvo solicitud explicita
- usar lenguaje de resultados: seguridad, durabilidad, terminacion, respaldo y tranquilidad
- no inventar precio, stock, descuento, pago, agenda ni plazo

Ejemplo:

> Perfecto, un cierre de placas reforzadas es una alternativa resistente para delimitar y dar mayor seguridad al terreno. Para orientarte bien, ¿cuantos metros lineales necesitas cubrir aproximadamente?

## Memoria de calificacion

`conversations.qualification_context` conserva, cuando aplica:

- producto o servicio y modalidad
- comuna, medidas, cantidad y uso
- terreno, acceso, escombros, urgencia y fotos
- tipo de cliente y datos B2B
- D.A.T.O.S., objeciones y clasificacion A/B/C/D
- confirmacion, resumen ejecutivo y siguiente accion

`pending_question_key` identifica exactamente que pregunta esta respondiendo el cliente. Por ejemplo, un `no` puede significar que no hay escombros, que no tiene fotos o que no confirma el resumen; no borra el contexto ni reinicia la conversacion.

## Diagnostico adaptativo

El asesor prioriza los datos que mas reducen incertidumbre comercial. No existe un orden universal, pero cada intencion tiene datos criticos.

Para instalacion o cierres, normalmente se valida:

1. producto o solucion buscada
2. comuna
3. medidas aproximadas
4. tipo de terreno
5. acceso para camion
6. retiro de escombros, si aplica
7. confirmacion del resumen

Para material, despacho, B2B, reclamo, garantia, pago, stock, descuento o competencia, se usa el diagnostico especifico definido por el PRD y las fuentes comerciales.

Los datos secundarios pueden quedar pendientes para la ejecutiva si no impiden entender la oportunidad.

## Regla de creacion

El lead se crea cuando:

- existe una necesidad comercial real
- se conoce el producto o servicio
- se conoce la comuna o zona relevante
- existe un requerimiento suficientemente concreto
- estan disponibles los datos criticos de la intencion
- el cliente confirma el siguiente paso cuando corresponde

No se crea por un saludo aislado, una respuesta vacia o una intencion demasiado ambigua.

## Creacion y asignacion

`CRM - Lead Creation And Assignment`:

- crea el lead con el contexto validado
- copia `qualification_context`
- asigna vendedor mediante round robin
- registra el historial de asignacion
- devuelve `lead_id` y vendedor asignado

El orquestador no anuncia una derivacion si no existe `lead_id`.

## ClickUp y notificacion

`CRM - ClickUp Sync Lead` crea la tarea en `Leads Entrantes` con:

- identidad y contacto
- producto, comuna, modalidad y necesidad
- medidas y condiciones relevantes
- clasificacion, D.A.T.O.S. y objeciones
- resumen ejecutivo
- conversacion completa
- vendedor asignado

La notificacion al vendedor ocurre despues de crear la tarea. Si ClickUp o la notificacion fallan, el error queda auditable y nunca se presenta al cliente una operacion fallida como completada.

## Continuidad y duplicados

- dentro de 24 horas se recupera la conversacion activa y su pregunta pendiente
- una solicitud nueva solo comienza cuando el cliente lo pide de forma explicita o la politica de continuidad lo determina
- los datos previos no se reutilizan silenciosamente para una solicitud distinta
- los reinicios y cambios de solicitud quedan registrados

## Adjuntos

Las fotos y documentos se registran como metadata y pueden alimentar el diagnostico. La carga del binario real a ClickUp sigue siendo una mejora posterior.

## Fallback

Las preguntas deterministicas se usan solamente si Gemini:

- falla o no responde
- entrega JSON invalido
- presenta baja confianza
- viola guardrails del PRD

El fallback conserva memoria y formula una pregunta segura; no reemplaza la conversacion normal del asesor.

## Validacion

```bash
sh scripts/dev/sync-n8n-workflows.sh --preflight
sh scripts/ops/test-ai-assistant-local.sh
sh scripts/ops/test-conversation-regression-local.sh
sh scripts/ops/test-advisor-vitacura-e2e.sh
```
