# Flujo de Leads

## Objetivo

Describir el flujo funcional del lead desde el primer mensaje entrante hasta la asignacion comercial.

## Resumen del flujo

1. El cliente escribe por WhatsApp.
2. El sistema registra el mensaje y responde con bienvenida inmediata.
3. El bot inicia una conversacion guiada para obtener:
   - servicio
   - ciudad
   - requerimiento
4. Si el cliente ya entrego datos utiles en un mensaje libre, el sistema los extrae y salta preguntas ya resueltas.
5. Si el sistema obtiene `2 de 3 + intencion real`, crea el lead.
6. Si falla la comprension dos veces, deriva igual al vendedor y crea el lead como parcial.
7. Antes de crear la tarea en ClickUp, el sistema asigna vendedor por round robin.
8. El lead se crea en ClickUp en la lista `Leads Entrantes`.
9. Se notifica al vendedor asignado por WhatsApp interno y queda respaldo operativo en ClickUp.

## Textos base del bot

### Bienvenida

`Hola, gracias por escribirnos. Para ayudarte mejor, te haré unas preguntas breves.`

### Pregunta por servicio

`¿Qué servicio estás buscando?`

### Pregunta por ciudad

`¿Desde qué ciudad nos escribes?`

### Pregunta por requerimiento

`Cuéntame brevemente qué necesitas o qué tipo de requerimiento tienes.`

### Reencauce por respuesta fuera de flujo

`Para poder ayudarte mejor, necesito completar unos datos primero.`

Luego se repite la pregunta pendiente correspondiente.

### No comprension

Primer intento de aclaracion:

`No logré entender bien tu respuesta. ¿Podrías indicármelo de otra forma?`

Segundo intento fallido:

`Voy a derivar tu solicitud a una asesora para continuar la atención contigo directamente.`

### Derivacion correcta

`Perfecto, ya tengo la información necesaria. Voy a derivar tu solicitud a una asesora para que continúe contigo.`

## Datos funcionales validados

- canal principal: WhatsApp oficial
- calificacion: guiada con capacidad de extraer contexto libre
- criterio base de creacion: `2 de 3 + intencion`
- politica de duplicados: mismo telefono, con ventana de 24 horas para retomar conversacion
- estrategia de notificacion: WhatsApp interno con respaldo operativo en ClickUp
- asignacion: round robin secuencial simple
- adjuntos: se registran como metadata y luego se agregan a la tarea en ClickUp

## Flujo paso a paso

### 1. Recepcion del mensaje

- entra un mensaje desde WhatsApp oficial
- se registra el payload crudo en base de datos
- se crea o recupera la conversacion activa del telefono
- si no existe una conversacion activa, se inicia una nueva

### 2. Deteccion de contexto y respuesta inmediata

- el sistema responde con bienvenida
- intenta extraer desde el primer mensaje:
  - servicio
  - ciudad
  - requerimiento
- si algun dato ya fue detectado, no vuelve a preguntar por ese campo

### 3. Calificacion guiada

Orden base del flujo:

1. servicio
2. ciudad
3. requerimiento

Reglas:

- si el cliente ya respondio un dato, se salta esa pregunta
- si una respuesta queda incompleta, el flujo puede pasar a la siguiente y completar luego
- si el usuario responde fuera de flujo, el sistema intenta reencauzar
- si falla la comprension dos veces, el lead se crea igual y se deriva como parcial

### 4. Regla de calificacion

Se considera que el lead puede crearse cuando:

- existe intencion real
- y el sistema obtuvo al menos `2 de 3` entre:
  - `service`
  - `city`
  - `requirement`

### 5. Definicion de intencion real

Se considera intencion real cuando:

- el cliente envia al menos una respuesta util no vacia
- y la respuesta no es solo un saludo aislado o texto irrelevante

### 6. Duplicados y continuidad

Si el mismo telefono vuelve a escribir:

- dentro de 24 horas:
  - se retoma la conversacion activa
  - se continúa desde la ultima pregunta pendiente

- despues de 24 horas:
  - se inicia nueva conversacion
  - se envia nueva bienvenida
  - se puede crear un nuevo lead enlazado al anterior
  - si no hay datos nuevos, el nuevo lead puede heredar datos previos

### 7. Conversaciones abandonadas

Si el cliente deja de responder:

- no se crea lead automaticamente si no hubo informacion suficiente
- la conversacion se marca como `Inactiva por Tiempo`
- se registra evento de auditoria

## Manejo de adjuntos

Si el cliente envia imagen, PDF, audio u otro adjunto:

- se guarda metadata del adjunto
- se conserva el enlace o identificador externo si viene en el payload
- el bot continua el flujo normal
- si el adjunto llega sin texto, igual se hace la siguiente pregunta pendiente
- cuando se cree la tarea en ClickUp, el adjunto debe agregarse a la tarea

## Creacion del lead

### Cuándo se crea

El lead se crea cuando:

- se cumple `2 de 3 + intencion real`
- o cuando falla la comprension dos veces

### Cuándo no se crea

- si no hay respuesta util todavia
- si solo hubo saludo o mensaje sin contenido aprovechable

### Estado esperado

- si la informacion esta incompleta pero hubo derivacion, el lead queda como parcial
- si la informacion es suficiente, queda como completo

## Asignacion round robin

- la asignacion ocurre antes de crear la tarea en ClickUp
- la asignacion es secuencial simple
- se registra en historial de asignaciones
- si existe `clickup_user_id`, el vendedor queda tambien como assignee en ClickUp

## Creacion en ClickUp

### Lista objetivo

- `Leads Entrantes`

### Nombre de tarea

- `Nombre - Servicio - Ciudad`

### Contenido de la tarea

La tarea debe incluir:

- datos estructurados del lead en custom fields
- resumen del lead
- telefono
- canal
- vendedor asignado
- link o referencia de WhatsApp si aplica

### Historial conversacional

- el resumen principal puede ir en la descripcion
- la conversacion completa debe agregarse como comentario con el titulo:
  - `Conversación Completa Cliente`

### Adjuntos

- los adjuntos deben agregarse a la tarea cuando la integracion este operativa

## Notificacion al vendedor

### Canal principal

- WhatsApp interno

### Respaldo operativo

- asignacion visible en ClickUp

### Contenido minimo

- nombre del lead
- telefono
- servicio
- ciudad
- resumen del requerimiento
- link de ClickUp

### Politica de fallo

- se realizan 3 reintentos
- si falla, se registra auditoria
- y el lead debe quedar marcado con incidente operativo

## Errores y reintentos

### WhatsApp saliente

Se aplican reintentos automaticos a:

- bienvenida
- preguntas de calificacion
- mensaje de derivacion
- notificacion interna al vendedor

### ClickUp

Si falla la creacion de tarea:

- se realizan reintentos automaticos
- si no resulta, el lead queda en error para revision
- la asignacion previa no se pierde

### PostgreSQL

Si la persistencia falla temporalmente:

- el flujo debe cortarse
- no debe seguir respondiendo como si el estado hubiera quedado guardado
- debe registrarse incidente operativo cuando sea posible

## Estados y transiciones funcionales esperadas

### Conversacion

Estados operativos relevantes:

- `Activa`
- `Esperando Respuesta`
- `Fuera de Flujo`
- `Derivada a Ventas`
- `Inactiva por Tiempo`
- `Cerrada`
- `Error`

### Lead

Estados operativos relevantes:

- `Borrador`
- `Calificado Parcial`
- `Calificado Completo`
- `Creado en ClickUp`
- `Asignado`
- `Notificado`
- `Cerrado`
- `Error`

## Pendientes de fases siguientes

- definir campos exactos en ClickUp
- construir workflows concretos en `n8n`
- conectar WhatsApp oficial
- conectar ClickUp API
