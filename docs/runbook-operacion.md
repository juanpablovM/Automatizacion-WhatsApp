# Runbook Operativo

## Alcance

Este runbook cubre la operacion local controlada del CRM WhatsApp + AI:

- reiniciar servicios
- sincronizar workflows
- revisar logs
- correr backup
- verificar restore no destructivo
- validar `OPS - Error Handler`
- reconectar Evolution API por QR o pairing
- activar o desactivar `AI - Lead Qualification Assistant`

Los scripts operativos cargan `.env`. Solo el integrador o la persona a cargo de la instancia real debe ejecutarlos contra servicios vivos.

## Reglas de seguridad

- No commitear `.env`, backups, logs ni salidas con secretos.
- Usar `.env.example` para documentacion, muestras y pruebas mock.
- Redactar `EVOLUTION_API_KEY`, `EVOLUTION_WEBHOOK_SECRET`, `OPENCLAW_BRIDGE_TOKEN` y tokens de ClickUp en cualquier evidencia.
- Antes de exponer webhooks fuera del entorno local, verificar que `EVOLUTION_WEBHOOK_SECRET` exista y que el webhook persistido incluya `token` o `secret`.

## Healthcheck minimo

Desde la raiz del repo:

```bash
docker compose --env-file .env ps
curl -fsS http://127.0.0.1:5678/healthz
curl -fsS http://127.0.0.1:8080/
sh scripts/dev/evolution-doctor.sh
```

Resultado esperado:

- `n8n`, `postgres`, `redis` y `evolution-api` en estado running/healthy.
- `n8n` responde healthcheck.
- Evolution API responde y la instancia default existe.
- Si la instancia default no esta `open`, seguir la seccion de reconexion.

## Reiniciar servicios

Reinicio completo sin borrar volumenes:

```bash
docker compose --env-file .env up -d
docker compose --env-file .env ps
```

Reinicio puntual:

```bash
docker compose --env-file .env restart n8n
docker compose --env-file .env restart evolution-api
docker compose --env-file .env restart postgres
```

No usar `docker compose down -v` salvo decision explicita de borrar datos locales.

## Sincronizar workflows

Preflight local, sin tocar servicios:

```bash
sh scripts/dev/sync-n8n-workflows.sh --preflight
```

Sincronizacion real contra n8n local:

```bash
sh scripts/dev/sync-n8n-workflows.sh
```

Checklist posterior:

- La salida debe incluir `Verificacion remota OK`.
- La salida debe incluir `Workflow de entrada activado: WA - Inbound Entry`.
- `OPS - Error Handler` debe quedar como `errorWorkflow` de los workflows versionados.
- No editar `workflow_entity` manualmente.

Verificacion SQL opcional:

```bash
docker compose --env-file .env exec -T postgres sh -lc \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT name, active FROM workflow_entity ORDER BY name;"'
```

## Revisar logs

Logs en vivo:

```bash
docker compose --env-file .env logs -f n8n
docker compose --env-file .env logs -f evolution-api
docker compose --env-file .env logs -f postgres
docker compose --env-file .env logs -f redis
```

Ultimas lineas sin seguir:

```bash
docker compose --env-file .env logs --tail=200 n8n
docker compose --env-file .env logs --tail=200 evolution-api
```

Errores auditados por el CRM:

```bash
docker compose --env-file .env exec -T postgres sh -lc \
  "psql -U \"\$POSTGRES_USER\" -d \"\$APP_POSTGRES_DB\" -c \"SELECT id, event_name, metadata->>'workflow_name' AS workflow, metadata->>'last_node' AS last_node, created_at FROM audit_logs WHERE event_name LIKE '%error%' ORDER BY id DESC LIMIT 20;\""
```

## Backup local

Crear backup:

```bash
sh scripts/ops/backup-local.sh
```

El backup queda en `backups/<YYYYMMDD-HHMMSS>/` e incluye:

- `crm_whatsapp_app.dump`: base CRM de negocio.
- `crm_whatsapp_n8n.dump`: base interna de n8n.
- `n8n_data.tar.gz`: volumen `n8n_data`.
- `manifest.txt`: metadatos del backup.

Checklist:

- Confirmar que el directorio nuevo existe.
- Confirmar que los tres artefactos tienen tamano mayor a cero.
- No subir `backups/` a Git.
- Ejecutar la verificacion no destructiva antes de confiar en el backup.

## Verify restore no destructivo

Verificar el ultimo backup:

```bash
sh scripts/ops/verify-backup-local.sh
```

Verificar un backup especifico:

```bash
sh scripts/ops/verify-backup-local.sh backups/20260427-163804
```

El script no toca las bases reales. Procedimiento interno:

1. Copia los dumps al contenedor `postgres`.
2. Crea bases temporales `*_restore_check_<timestamp>`.
3. Restaura cada dump en su base temporal.
4. Cuenta tablas, leads y workflows.
5. Valida que `n8n_data.tar.gz` sea legible.
6. Elimina las bases temporales al salir, tambien si falla.

Resultado esperado:

- `Restore check OK`.
- `app_tables` mayor que `0`.
- `n8n_tables` mayor que `0`.
- `n8n_workflows` mayor que `0`.
- `n8n_volume_tar=readable`.

Si falla:

- No borrar el backup fallido.
- Guardar el error y `manifest.txt`.
- Revisar logs de `postgres`.
- Reintentar con otro backup si existe.
- No hacer restore destructivo sobre las bases reales sin un plan separado.

## Validar OPS - Error Handler

Prueba controlada:

```bash
sh scripts/ops/test-error-handler.sh
```

Opcionalmente usar un telefono sintetico distinto:

```bash
sh scripts/ops/test-error-handler.sh 56999999099
```

El script envia un evento autorizado al webhook local de `WA - Inbound Entry` con una bandera interna de prueba. El objetivo es forzar un fallo controlado sin volver a introducir ruido artificial por timestamps invalidos.

Resultado esperado:

- `OPS Error Handler smoke OK`.
- `audit_after` mayor que `audit_before`.
- Fila reciente en `audit_logs` con workflow y ultimo nodo.

Esta prueba genera auditoria operativa. No ejecutarla durante una prueba comercial real sin registrar la evidencia como smoke test.

Estado real actual:

- el smoke fue actualizado para usar una bandera explicita de prueba
- al momento del ultimo handoff, la prueba aun requiere ajuste adicional para registrar consistentemente la auditoria nueva
- no usar su resultado como unico indicador de salud del flujo principal de WhatsApp

## Pendientes operativos conocidos

- Persisten lineas historicas en logs de `n8n` asociadas a webhooks viejos. No corresponden a la configuracion activa actual.
- El flujo principal de WhatsApp ya fue validado nuevamente con una conversacion real completa.
- La guia de salida a produccion del proyecto vive en [`docs/guia-produccion.md`](/home/agentesai/Automatizacion-WhatsApp/docs/guia-produccion.md).

## Reconectar Evolution API por QR

Diagnostico:

```bash
sh scripts/dev/evolution-doctor.sh
```

Si la instancia default no existe:

```bash
sh scripts/dev/evolution-create-instance.sh
```

Solicitar QR o pairing data:

```bash
sh scripts/dev/evolution-connect-instance.sh
```

Despues de escanear el QR o completar el pairing:

```bash
sh scripts/dev/evolution-doctor.sh
sh scripts/dev/evolution-set-webhook.sh
```

Checklist:

- Instancia default existe y queda en estado `open`.
- Webhook queda persistido hacia `host.docker.internal:5678`.
- La URL impresa por `evolution-set-webhook.sh` no muestra secretos reales.
- Evento configurado: `MESSAGES_UPSERT`, salvo cambio deliberado.
- No eliminar la instancia ni volumenes para reconectar, a menos que se haya decidido resetear la sesion.

## Activar o desactivar AI

Validacion local del contrato sin proveedor real:

```bash
sh scripts/ops/test-ai-assistant-local.sh
```

Desactivar AI:

```bash
# editar .env
AI_LEAD_ASSISTANT_ENABLED=false
docker compose --env-file .env up -d n8n
```

AI queda activada por defecto en modo API directa. Si la API key o el modelo siguen pendientes, el workflow omite IA y usa fallback deterministico.

Configuracion esperada para AI:

```bash
# editar .env
AI_LEAD_ASSISTANT_ENABLED=true
AI_PROVIDER=direct_api
AI_API_KEY_REQUIRED=true
AI_DIRECT_API_BASE_URL=https://api.openai.com/v1
AI_DIRECT_API_PATH=/responses
AI_DIRECT_API_KEY=<redacted>
AI_DIRECT_API_MODEL=<modelo elegido>
AI_DIRECT_API_TIMEOUT_MS=8000
docker compose --env-file .env up -d n8n
```

Checklist antes de activar:

- API key vigente y no expuesta en Git.
- Modelo definido en `AI_DIRECT_API_MODEL`.
- Revisar [`docs/ai-api-directa-configuracion.md`](/home/agentesai/Automatizacion-WhatsApp/docs/ai-api-directa-configuracion.md).
- `AI - Lead Qualification Assistant` pasa el test local.
- `sync-n8n-workflows.sh --preflight` pasa.
- Existe plan de rollback: volver a `AI_LEAD_ASSISTANT_ENABLED=false` y recrear `n8n`.

Reglas operativas:

- Hormi Atencion decide la conversacion y puede habilitar leads confirmados.
- n8n y PostgreSQL ejecutan persistencia, ClickUp y asignacion.
- Hormi Atencion no escribe directo en PostgreSQL ni crea tareas ClickUp fuera del workflow.
- Un lead sigue requiriendo `servicio + ciudad + requerimiento + confirmacion`.
- Si el proveedor AI falla, demora, responde invalido o devuelve baja confianza, el flujo debe caer a logica deterministica.

## Cierre de una ventana operativa

Antes de cerrar una sesion de trabajo:

```bash
git status --short
sh scripts/dev/sync-n8n-workflows.sh --preflight
sh scripts/ops/backup-local.sh
sh scripts/ops/verify-backup-local.sh
```

Registrar en la bitacora o handoff:

- fecha y hora
- branch
- comandos ejecutados
- backup verificado
- estado de Evolution API
- estado de AI (`enabled`/`disabled`)
- errores abiertos o riesgos
