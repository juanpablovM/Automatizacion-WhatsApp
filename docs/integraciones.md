# Integraciones

## Objetivo

Consolidar el inventario de integraciones externas y sus credenciales requeridas.

## Integraciones previstas

### Evolution API

- recepcion de mensajes entrantes por webhook
- envio de respuestas automaticas
- gestion de instancias por numero
- soporte futuro para multiples numeros

### ClickUp API

- creacion de tareas para leads
- asignacion inicial
- almacenamiento del historial conversacional y campos estructurados
- comentario adicional con la conversacion completa del cliente
- carga futura de adjuntos en la tarea
- uso de `field_id` y `option_id` reales para custom fields

### Notificacion interna

- canal prioritario: ClickUp
- comentario asignado al vendedor en la tarea del lead
- reintentos automaticos
- auditoria e incidente operativo si la notificacion falla

## Placeholders definidos

Los secretos reales no se guardan en el repositorio. Solo se dejan placeholders en `.env.example`.

## Estado actual de integraciones

En esta fase las integraciones externas ya quedaron parcialmente conectadas. La infraestructura local queda lista para:

- levantar el orquestador `n8n`
- persistir configuracion y ejecuciones en `PostgreSQL`
- operar `Evolution API` localmente
- usar ClickUp real sin versionar secretos

## Pendientes

- confirmar entorno de prueba o produccion por integracion
- crear la primera instancia de `Evolution API`
- escanear el QR del numero inicial
- decidir estrategia operativa para multiples instancias
