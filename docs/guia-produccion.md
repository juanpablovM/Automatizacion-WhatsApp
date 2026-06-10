# Guia de Produccion

## Objetivo

Convertir el estado actual del proyecto en una salida a produccion controlada, segura y operable.

Esta guia no describe una idea futura abstracta. Es una checklist de trabajo para este repo y debe usarse como referencia para cerrar pendientes reales antes de operar con trafico productivo.

La carpeta `.hermes` fue retirada del repo para evitar duplicar planes historicos. Esta guia pasa a ser la referencia operativa vigente para la salida a produccion.

## Estado actual resumido

Hoy el proyecto ya tiene:

- flujo local funcional con `Docker Compose`
- `n8n`, `PostgreSQL`, `Redis` y `Evolution API` levantando correctamente
- sesion de WhatsApp reconectada y validada
- webhook actual de `WA - Inbound Entry` persistido y operativo
- conversacion real de prueba procesada de punta a punta
- mensajes salientes reales enviados con estado `sent`
- lead y derivacion comercial funcionando en pruebas reales
- sincronizacion de workflows con script oficial de `n8n`
- correccion aplicada para que `scripts/dev/evolution-connect-instance.sh` use la instancia real configurada
- endurecimiento parcial del manejo de timestamps entrantes

Pendientes reales detectados:

- terminar de cerrar el smoke de `OPS - Error Handler`
- limpiar ruido historico de logs viejos para diagnostico mas claro
- formalizar despliegue productivo, secretos, backups y monitoreo
- separar claramente `dev`, `staging` y `prod`

## Plan de ejecucion por etapas

La salida a produccion no deberia atacarse como una lista plana. Conviene cerrarla en etapas, porque algunas tareas habilitan a las siguientes y otras solo tienen sentido cuando ya existe un ambiente casi definitivo.

### Etapa 0. Cerrar brechas del entorno actual

Objetivo:

- dejar el entorno local actual consistente, repetible y sin dudas operativas basicas

Incluye:

- cerrar el smoke de `OPS - Error Handler`
- limpiar ruido historico de logs que complique diagnostico
- repetir preflight y sincronizacion de workflows
- volver a validar backup y restore no destructivo
- repetir una prueba end-to-end real con AI apagada

Criterio de salida:

- flujo principal responde
- no hay errores abiertos que confundan el diagnostico
- backups y restore quedaron verificados
- el equipo puede distinguir una falla real de un log historico

#### Checklist operativa de Etapa 0

##### 0.1 Healthcheck base del stack

- [ ] Confirmar `docker compose --env-file .env ps` con `n8n`, `postgres`, `redis` y `evolution-api` arriba
- [ ] Confirmar `curl -fsS http://127.0.0.1:5678/healthz`
- [ ] Confirmar `curl -fsS http://127.0.0.1:8080/`
- [ ] Confirmar `sh scripts/dev/evolution-doctor.sh`

Evidencia esperada:

- servicios `running` o `healthy`
- `n8n` respondiendo healthcheck
- instancia WhatsApp existente y en estado `open`

##### 0.2 Sincronizacion y consistencia de workflows

- [ ] Ejecutar `sh scripts/dev/sync-n8n-workflows.sh --preflight`
- [ ] Ejecutar `sh scripts/dev/sync-n8n-workflows.sh`
- [ ] Confirmar que `WA - Inbound Entry` quede activo
- [ ] Confirmar que `OPS - Error Handler` quede asociado como workflow de errores

Evidencia esperada:

- salida con `Preflight local OK`
- salida con `Verificacion remota OK`
- salida con `Workflow de entrada activado: WA - Inbound Entry`

##### 0.3 Cierre del smoke de `OPS - Error Handler`

- [ ] Ejecutar `sh scripts/ops/test-error-handler.sh`
- [ ] Confirmar incremento real de auditoria
- [ ] Confirmar workflow y ultimo nodo en el registro creado
- [ ] Documentar brevemente el resultado del smoke

Evidencia esperada:

- `audit_after` mayor que `audit_before`
- fila nueva en `audit_logs`
- smoke repetible sin depender de payloads invalidos artificiales

Si falla:

- revisar `docs/runbook-operacion.md`
- revisar logs de `n8n`
- revisar si la bandera `__force_error_handler_test` esta entrando al workflow correcto
- no dar Etapa 0 por cerrada

##### 0.4 Backup y restore no destructivo

- [ ] Ejecutar `sh scripts/ops/backup-local.sh`
- [ ] Confirmar artefactos en `backups/<timestamp>/`
- [ ] Ejecutar `sh scripts/ops/verify-backup-local.sh`
- [ ] Guardar referencia del backup validado

Evidencia esperada:

- directorio nuevo de backup creado
- dumps con tamano mayor a cero
- `Restore check OK`
- verificacion legible de `n8n_data.tar.gz`

##### 0.5 Limpieza de diagnostico operativo

- [ ] Identificar lineas de logs que corresponden a webhooks historicos
- [ ] Dejar explicitado en documentacion que no son la configuracion activa
- [ ] Confirmar cual es el webhook activo real
- [ ] Evitar que el equipo use logs historicos como criterio de caida actual

Evidencia esperada:

- webhook activo identificado por URL o workflow
- runbook actualizado o validado contra el estado actual
- criterio compartido para distinguir ruido historico de falla real

##### 0.6 Prueba end-to-end real con AI apagada

- [ ] Confirmar `AI_LEAD_ASSISTANT_ENABLED=false`
- [ ] Ejecutar una conversacion real de punta a punta
- [ ] Confirmar respuesta saliente `sent`
- [ ] Confirmar derivacion, lead y sync en ClickUp
- [ ] Confirmar que no se creo lead sin datos minimos requeridos

Evidencia esperada:

- mensajes entrantes y salientes registrados
- `delivery_status='sent'`
- auditoria con derivacion comercial
- `clickup_task_sync` exitoso

##### 0.7 Cierre formal de Etapa 0

- [ ] Dejar nota corta de fecha, responsable y resultado
- [ ] Confirmar que no quedan bloqueantes abiertos para congelar baseline
- [ ] Marcar el sistema como candidato a Etapa 1

Evidencia esperada:

- registro documental simple del cierre
- lista clara de pendientes remanentes que ya no bloquean baseline

#### Definicion de terminado para Etapa 0

La Etapa 0 debe considerarse cerrada solo si se cumplen simultaneamente estas condiciones:

- el stack levanta de forma consistente
- los workflows sincronizan correctamente
- `OPS - Error Handler` deja auditoria repetible
- backup y restore no destructivo fueron validados
- el flujo real de WhatsApp funciona con AI apagada
- el equipo ya no esta diagnosticando contra ruido historico

### Etapa 1. Congelar baseline funcional

Objetivo:

- definir una version base estable del sistema antes de moverlo a un ambiente mas serio

Incluye:

- congelar imagenes y tags
- consolidar nombres finales de instancia, workflows y variables
- dejar documentado el procedimiento de sync y rollback de workflows
- confirmar comportamiento conversacional completo con `AI_LEAD_ASSISTANT_ENABLED=false`
- confirmar que lead, round robin, ClickUp y notificacion funcionan sin depender de AI

Criterio de salida:

- existe un baseline deterministico
- el flujo comercial funciona con logica no asistida
- los nombres y configuraciones base ya no estan cambiando

### Etapa 2. Preparar infraestructura de staging

Objetivo:

- levantar un ambiente que represente produccion sin poner en riesgo el numero o la operacion final

Incluye:

- definir host de `staging`
- configurar dominio, DNS, proxy y HTTPS
- separar variables y secretos de `staging`
- proteger acceso a `n8n`, `postgres` y `redis`
- validar reinicio automatico y capacidad de recursos

Criterio de salida:

- existe un ambiente accesible, protegido y reproducible
- los servicios sobreviven reinicios
- ya no se depende solo del entorno local para validar cambios

### Etapa 3. Endurecer datos, seguridad y recuperacion

Objetivo:

- dejar controlados los riesgos de perdida de datos, fuga de secretos y recuperacion ante fallas

Incluye:

- rotar secretos productivos y de staging
- definir responsable de custodia
- probar backup automatico
- probar restore real desde backup en entorno controlado
- definir retencion de backups
- revisar exposicion de logs, evidencias y variables

Criterio de salida:

- secretos rotados y aislados
- restauracion probada con evidencia
- existe una politica minima de recuperacion y resguardo

### Etapa 4. Validacion funcional ampliada

Objetivo:

- someter el flujo a pruebas mas cercanas al uso real y cubrir casos de borde antes de abrir trafico productivo

Incluye:

- ejecutar matriz conversacional completa
- cubrir timestamps enteros, decimales y vacios
- probar mensajes sin texto y payloads malformados controlados
- confirmar comportamiento con duplicados y reanudacion dentro y fuera de 24 horas
- verificar que no responda a grupos ni a mensajes propios
- confirmar comportamiento cuando ClickUp falle

Criterio de salida:

- los casos principales y de borde tienen evidencia
- no quedan fallas conocidas en rutas criticas
- la operacion comercial tiene expectativas claras de comportamiento

### Etapa 5. Activar AI en entorno controlado

Objetivo:

- validar Hormi Atencion por API directa como capa conversacional oficial sin romper el flujo deterministico de respaldo

Incluye:

- activar AI en `staging` o workspace del integrador con `AI_PROVIDER=direct_api`
- validar respuestas reales de Hormi Atencion via proveedor directo
- validar API key/modelo segun `docs/ai-api-directa-configuracion.md`
- confirmar fallback deterministico cuando AI falle
- confirmar que Hormi Atencion no persiste ni asigna por fuera de los workflows
- comparar comportamiento con y sin AI sobre conversaciones reales de prueba

Criterio de salida:

- AI agrega valor sin romper el baseline
- el sistema sigue siendo operable aunque el proveedor AI falle
- queda evidencia de que Hormi Atencion puede operar en produccion con rollback a `AI_LEAD_ASSISTANT_ENABLED=false`

### Etapa 6. Preparar operacion diaria

Objetivo:

- asegurar que el sistema pueda sostenerse en el tiempo, no solo arrancar

Incluye:

- definir monitoreo y alertas
- documentar runbook de reinicio, reconexion y soporte
- definir responsable operativo
- definir proceso de escalamiento ante caidas
- medir mensajes entrantes, salientes y fallidos

Criterio de salida:

- existe una forma concreta de detectar y responder a incidentes
- la operacion no depende de memoria informal
- alguien sabe que hacer cuando “no responde”

### Etapa 7. Corte a produccion controlado

Objetivo:

- hacer el paso a produccion con una secuencia simple, verificable y reversible

Incluye:

- desplegar el stack final
- persistir webhook y sesion del numero final
- correr prueba real final end-to-end
- verificar ClickUp, asignacion y notificacion
- dejar comando y criterio de rollback documentados

Criterio de salida:

- el numero productivo responde
- se crean leads validos
- existe evidencia de salida y recuperacion minima

## Orden recomendado de trabajo desde hoy

Si hubiera que seguir desde el estado actual del repo, el orden mas sensato seria:

1. cerrar `OPS - Error Handler`
2. volver a correr backup y verify restore
3. congelar baseline sin AI
4. montar `staging` con proxy, HTTPS y secretos separados
5. correr matriz funcional y casos de borde en `staging`
6. activar AI en entorno controlado
7. recien despues preparar el corte a `prod`

## Dependencias entre frentes

- No tiene sentido abrir `prod` si antes no esta resuelto backup y restore.
- No conviene validar AI seriamente si el baseline sin AI aun cambia.
- No conviene discutir monitoreo final sin haber definido `staging` y `prod`.
- El cierre de `OPS - Error Handler` mejora mucho la capacidad de diagnostico para todas las etapas siguientes.

## Proximo foco recomendado

El siguiente bloque de trabajo con mejor retorno hoy es:

1. dejar completamente operativo `OPS - Error Handler`
2. ejecutar una pasada formal de backup y restore con evidencia
3. marcar el baseline sin AI como version candidata para `staging`

Eso te deja una base mucho mas firme para pasar de “funciona en local” a “podemos empezar a prepararlo en serio para produccion”.

## Checklist de salida a produccion

### 1. Infraestructura

- [ ] Definir host productivo final
- [ ] Definir ambiente `staging`
- [ ] Definir ambiente `prod`
- [ ] Configurar dominio y DNS
- [ ] Montar reverse proxy
- [ ] Habilitar HTTPS con certificados validos
- [ ] Restringir puertos publicos al minimo necesario
- [ ] Verificar reinicio automatico de servicios
- [ ] Verificar capacidad de CPU, RAM y disco

### 2. Contenedores y despliegue

- [ ] Congelar imagenes y tags a versiones explicitas
- [ ] Definir archivo de entorno de produccion separado
- [ ] Documentar comando de deploy
- [ ] Documentar comando de rollback
- [ ] Verificar que `n8n` no quede expuesto sin proteccion
- [ ] Verificar que `postgres` no quede expuesto a internet
- [ ] Verificar que `redis` no quede expuesto a internet

### 3. Secretos y seguridad

- [ ] Rotar `EVOLUTION_API_KEY`
- [ ] Rotar `EVOLUTION_WEBHOOK_SECRET`
- [ ] Rotar credenciales de PostgreSQL si fueron usadas en desarrollo
- [ ] Rotar tokens de ClickUp si corresponde
- [ ] Rotar `OPENCLAW_BRIDGE_TOKEN` si corresponde
- [ ] Confirmar que `.env` real no se comparte ni se versiona
- [ ] Confirmar que logs y evidencias no imprimen secretos
- [ ] Definir responsable de custodiar secretos

### 4. Base de datos

- [ ] Verificar migraciones completas en `crm_whatsapp_app`
- [ ] Verificar migraciones completas en `crm_whatsapp`
- [ ] Verificar base `evolution_api`
- [ ] Confirmar indices en tablas operativas
- [ ] Probar backup automatico
- [ ] Probar restore real desde backup
- [ ] Definir retencion de backups
- [ ] Definir limpieza historica de datos si aplica

### 5. n8n

- [ ] Ejecutar `sh scripts/dev/sync-n8n-workflows.sh --preflight`
- [ ] Ejecutar `sh scripts/dev/sync-n8n-workflows.sh`
- [ ] Verificar que `WA - Inbound Entry` quede activo
- [ ] Verificar sub-workflows enlazados correctamente
- [ ] Verificar credenciales internas de `n8n`
- [ ] Verificar `OPS - Error Handler` como workflow de errores
- [ ] Validar importacion y rollback de workflows

### 6. Evolution API y WhatsApp

- [ ] Confirmar que la instancia productiva quede `open`
- [ ] Confirmar nombre final de la instancia
- [ ] Persistir webhook productivo real
- [ ] Confirmar evento `MESSAGES_UPSERT`
- [ ] Documentar procedimiento de reconexion por QR
- [ ] Documentar procedimiento de caida de sesion
- [ ] Verificar envio y recepcion reales con el numero final

### 7. Flujo funcional

- [ ] Probar saludo inicial
- [ ] Probar captura de ciudad
- [ ] Probar captura de servicio
- [ ] Probar captura de requerimiento
- [ ] Probar confirmacion positiva
- [ ] Probar rechazo y reinicio de conversacion
- [ ] Probar derivacion comercial
- [ ] Probar mensajes repetidos o duplicados
- [ ] Probar reanudacion dentro de 24 horas
- [ ] Probar comportamiento despues de 24 horas

### 8. Casos de borde

- [ ] Probar timestamp entero
- [ ] Probar timestamp decimal
- [ ] Probar timestamp vacio
- [ ] Probar payload malformado controlado
- [ ] Probar mensaje sin texto
- [ ] Probar imagen con caption
- [ ] Probar audio o documento si se usaran en operacion
- [ ] Confirmar que no responda a grupos
- [ ] Confirmar que no responda a mensajes propios

### 9. CRM, asignacion y ClickUp

- [ ] Confirmar creacion de lead solo con datos confirmados
- [ ] Confirmar round robin real
- [ ] Confirmar sync de tarea en ClickUp
- [ ] Confirmar comentario conversacional en ClickUp
- [ ] Confirmar notificacion al vendedor
- [ ] Confirmar comportamiento cuando ClickUp falle
- [ ] Confirmar comportamiento cuando no haya vendedor notificable

### 10. AI

- [ ] Ejecutar baseline con `AI_LEAD_ASSISTANT_ENABLED=false`
- [ ] Activar AI en entorno controlado con `AI_PROVIDER=direct_api`
- [ ] Validar respuestas de Hormi Atencion con trafico real
- [ ] Confirmar que API key/modelo y salida JSON estructurada fueron probados antes de produccion
- [ ] Confirmar fallback deterministico cuando AI falle
- [ ] Confirmar que Hormi Atencion solo habilite leads con confirmacion explicita
- [ ] Confirmar que Hormi Atencion no escriba directo a PostgreSQL
- [ ] Confirmar que Hormi Atencion no cree tareas en ClickUp fuera del workflow

### 11. Observabilidad

- [ ] Definir donde mirar logs de `n8n`
- [ ] Definir donde mirar logs de `Evolution API`
- [ ] Definir donde mirar logs de `PostgreSQL`
- [ ] Crear alerta por contenedor caido
- [ ] Crear alerta por sesion WhatsApp cerrada
- [ ] Crear alerta por errores de workflow
- [ ] Medir mensajes entrantes, salientes y fallidos

### 12. Operacion diaria

- [ ] Tener runbook de reinicio
- [ ] Tener runbook de reconexion de WhatsApp
- [ ] Tener runbook de “no responde”
- [ ] Tener runbook de backup y restore
- [ ] Definir responsable operativo
- [ ] Definir proceso de soporte

## Prioridad recomendada

### Critico antes de produccion

- [ ] secretos productivos rotados
- [ ] HTTPS y proxy configurados
- [ ] backups y restore probados
- [ ] WhatsApp productivo estable y `open`
- [ ] prueba end-to-end real completa
- [ ] validacion de ClickUp y round robin

### Importante para estabilizacion

- [ ] monitoreo y alertas
- [ ] cierre del smoke de `OPS - Error Handler`
- [ ] limpieza de ruido historico de logs
- [ ] matriz de pruebas conversacionales repetible

### Deseable despues de go-live controlado

- [ ] endurecer manejo de medios adicionales
- [ ] automatizar healthchecks y reportes
- [ ] documentar despliegue continuo o semiautomatico

## Criterio minimo para decir “listo para produccion”

No deberia considerarse listo para produccion hasta que se cumplan al menos estas condiciones:

- infraestructura productiva definida y protegida
- secretos rotados y aislados
- backups validados con restore
- sesion WhatsApp estable
- flujo real end-to-end funcionando
- lead, ClickUp y notificacion validados
- runbook basico operativo disponible
