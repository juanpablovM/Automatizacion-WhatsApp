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
5. Si hay intencion pero faltan datos, el sistema pregunta por el dato pendiente.
6. Antes de crear el lead, el sistema confirma `servicio + ciudad + requerimiento concreto`.
7. Antes de crear la tarea en ClickUp, el sistema asigna vendedor por round robin.
8. El lead se crea en ClickUp en la lista `Leads Entrantes`.
9. Se notifica al vendedor asignado directamente en ClickUp cuando la tarea ya existe.

## Textos base del bot

### Bienvenida

`Hola, gracias por escribirnos. Para ayudarte mejor, te haré unas preguntas breves.`

### Pregunta por servicio

`¿Qué producto o servicio específico necesitas cotizar?`

### Pregunta por ciudad

`¿Desde qué ciudad necesitas el servicio?`

### Pregunta por requerimiento

`Cuéntame brevemente qué necesitas resolver, instalar, reparar o comprar.`

### Reencauce por respuesta fuera de flujo

`Para poder ayudarte mejor, necesito completar unos datos primero.`

Luego se repite la pregunta pendiente correspondiente.

### No comprension

Primer intento de aclaracion:

`No logré entender bien tu respuesta. ¿Podrías indicármelo de otra forma?`

Confirmacion antes de derivar:

`Tengo esto: servicio X, ciudad Y, requerimiento Z. ¿Está correcto?`

### Derivacion correcta

`Perfecto, ya tengo la información confirmada. Voy a derivar tu solicitud para que continúen contigo.`

## Datos funcionales validados

- canal principal: WhatsApp oficial
- calificacion: guiada con capacidad de extraer contexto libre
- criterio base de creacion: `servicio + ciudad + requerimiento concreto + confirmacion`
- politica de duplicados: mismo telefono, con ventana de 24 horas para retomar conversacion y confirmacion antes de reutilizar datos previos
- estrategia de notificacion: comentario/asignacion directa en ClickUp
- asignacion: round robin secuencial simple
- adjuntos: se registran como metadata; la carga del binario real a ClickUp queda pendiente

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
- si hay solo intencion y ciudad, se pregunta por producto o servicio especifico
- si hay servicio y ciudad, se pregunta por requerimiento concreto

### 4. Regla de calificacion

Se considera que el lead puede crearse cuando:

- existe intencion real
- existe `service`
- existe `city`
- existe `requirement` concreto
- el cliente confirmo los datos o los completo claramente dentro del flujo

### 5. Definicion de intencion real

Se considera intencion real cuando:

- el cliente envia al menos una respuesta util no vacia
- y la respuesta no es solo un saludo aislado o texto irrelevante
- detectar intencion no equivale a tener datos suficientes para crear lead

### 6. Duplicados y continuidad

Si el mismo telefono vuelve a escribir:

- dentro de 24 horas:
  - se retoma la conversacion activa
  - se continúa desde la ultima pregunta pendiente
  - si la conversacion ya fue derivada, se pregunta si quiere continuar o iniciar una nueva

- despues de 24 horas:
  - se inicia nueva conversacion
  - si existe un lead previo, se pregunta si quiere continuar con esa solicitud o iniciar una nueva
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
- `CRM - ClickUp Sync Lead` ya puede leer metadata de adjuntos, pero la carga del binario real a la tarea queda para una fase posterior

## Creacion del lead

### Cuándo se crea

El lead se crea cuando:

- se cumple `servicio + ciudad + requerimiento concreto`
- el cliente confirma el resumen antes de derivar

### Cuándo no se crea

- si no hay respuesta util todavia
- si solo hubo saludo o mensaje sin contenido aprovechable
- si solo hay intencion inicial, por ejemplo `quiero cotizar en Santiago`
- si falta requerimiento concreto

### Estado esperado

- si la informacion no esta completa, el lead no se crea
- si la informacion fue confirmada, queda como completo

## Asignacion round robin

- la asignacion ocurre antes de crear la tarea en ClickUp
- la asignacion es secuencial simple entre vendedores notificables
- un vendedor notificable debe estar activo y tener `clickup_user_id`
- se registra en historial de asignaciones
- el vendedor queda tambien como assignee en ClickUp

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
- la conversacion completa se agrega como comentario con el titulo:
  - `Conversación Completa Cliente`
- el comentario no bloquea la salida del subworkflow ni la notificacion al vendedor si falla

### Adjuntos

- los adjuntos deben agregarse a la tarea cuando la integracion este operativa

## Notificacion al vendedor

### Canal principal

- ClickUp

### Mecanismo

- la tarea queda asignada al vendedor
- el workflow agrega un comentario en la tarea y lo asigna al `clickup_user_id`

### Contenido minimo

- nombre del lead
- telefono
- servicio
- ciudad
- resumen del requerimiento
- link de ClickUp

### Politica de fallo

- se realizan reintentos con backoff para errores de red y estados reintentables
- si el fallo persiste, se registra auditoria y se marca incidente cuando corresponde

## Errores y reintentos

### WhatsApp saliente

Existe reintento con backoff para:

- bienvenida
- preguntas de calificacion
- mensaje de derivacion
- notificacion interna al vendedor

### ClickUp

Si falla la creacion de tarea:

- se reintenta con backoff antes de marcar fallo final
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

- revisar los casos con mensajes salientes marcados como fallidos durante validacion
- mantener activo `EVOLUTION_WEBHOOK_SECRET` antes de cualquier exposicion publica
- validar reintentos con fallos externos reales o simulados
- validar `AI - Lead Qualification Assistant` con proveedor real controlado y mantener fallback deterministico
- implementar carga segura de adjuntos binarios en ClickUp cuando exista contrato operativo para medios
