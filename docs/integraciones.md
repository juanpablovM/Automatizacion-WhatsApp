# Integraciones

## Objetivo

Consolidar el inventario de integraciones externas y sus credenciales requeridas.

## Integraciones previstas

### WhatsApp Cloud API

- recepcion de mensajes entrantes
- envio de respuestas automaticas
- soporte futuro para multiples numeros

### ClickUp API

- creacion de tareas para leads
- asignacion inicial
- almacenamiento del historial conversacional y campos estructurados
- comentario adicional con la conversacion completa del cliente
- carga futura de adjuntos en la tarea
- uso de `field_id` y `option_id` reales para custom fields

### Notificacion interna

- canal prioritario: WhatsApp interno
- respaldo operativo: ClickUp
- reintentos automaticos
- auditoria e incidente operativo si la notificacion falla

## Placeholders definidos

Los secretos reales no se guardan en el repositorio. Solo se dejan placeholders en `.env.example`.

## Estado actual de integraciones

En esta fase las integraciones externas aun no estan conectadas. La infraestructura local queda lista para:

- levantar el orquestador `n8n`
- persistir configuracion y ejecuciones en `PostgreSQL`
- preparar credenciales futuras sin versionar secretos

## Pendientes

- confirmar entorno de prueba o produccion por integracion
- definir credenciales efectivas
- decidir estrategia de prueba para WhatsApp oficial
