# Publicación segura del webhook de ClickUp con Tailscale Funnel

Este runbook publica únicamente el webhook `OPS - Handoff ClickUp Closure` mediante HTTPS en el puerto `8443`. Mantiene intacto el servicio privado de Tailscale Serve en `443`, autentica cada evento con HMAC-SHA256 y conserva una ruta de reversión completa.

> **Efectos externos:** habilitar Funnel hace pública una ruta del host; registrar el webhook crea una integración real en ClickUp; cambiar el estado de una tarea de aceptación puede actualizar `handoffs` y cerrar una conversación. Cada bloque marcado como **GATE** requiere revisar su resultado antes de continuar.

## Alcance y contrato

| Elemento | Valor |
|---|---|
| Workflow | `OPS - Handoff ClickUp Closure` |
| Archivo | `n8n/workflows/ops-handoff-clickup-closure.json` |
| Puerto público | `8443` |
| Ruta pública única | `/clickup-handoff-closure` |
| Destino local | `http://127.0.0.1:5678/webhook/clickup-handoff-closure` |
| Evento ClickUp | `taskStatusUpdated` |
| Alcance ClickUp | Solo `CLICKUP_HANDOFF_LIST_ID` |
| Autenticación | Header `X-Signature`, HMAC-SHA256 hexadecimal |

No se debe publicar el editor de n8n, PostgreSQL, Evolution API ni la raíz de `127.0.0.1:5678`.

## 1. Preparar la sesión

Ejecutar desde la raíz del repositorio:

```bash
cd /home/agentesai/Automatizacion-WhatsApp
umask 077

test -f .env
chmod 600 .env

set -a
. ./.env
set +a

export WORKFLOW_NAME='OPS - Handoff ClickUp Closure'
export WORKFLOW_FILE='n8n/workflows/ops-handoff-clickup-closure.json'
export PUBLIC_PATH='/clickup-handoff-closure'
export BACKEND_URL='http://127.0.0.1:5678/webhook/clickup-handoff-closure'
```

Confirmar dependencias y variables sin imprimir credenciales:

```bash
for command in curl docker jq python3 tailscale; do
  command -v "$command" >/dev/null || {
    printf 'Falta la dependencia: %s\n' "$command" >&2
    exit 1
  }
done

for variable in CLICKUP_API_TOKEN CLICKUP_TEAM_ID CLICKUP_HANDOFF_LIST_ID; do
  eval "value=\${$variable:-}"
  test -n "$value" && test "$value" != '__PENDIENTE__' || {
    printf 'Falta configurar: %s\n' "$variable" >&2
    exit 1
  }
done

jq -e '
  .name == "OPS - Handoff ClickUp Closure"
  and .active == false
  and any(.nodes[];
    .type == "n8n-nodes-base.webhook"
    and .parameters.httpMethod == "POST"
    and .parameters.path == "clickup-handoff-closure")
' "$WORKFLOW_FILE" >/dev/null

docker compose --env-file .env ps
curl --fail --silent --show-error http://127.0.0.1:5678/healthz >/dev/null
tailscale status >/dev/null
```

### GATE 1 — preflight

Continuar solo si:

- n8n y PostgreSQL están sanos;
- Tailscale está conectado y MagicDNS está habilitado;
- el JSON declara `active: false` y la ruta esperada;
- `CLICKUP_API_TOKEN`, `CLICKUP_TEAM_ID` y `CLICKUP_HANDOFF_LIST_ID` están configurados;
- no se mostró ningún secreto en la terminal.

## 2. Verificar que Serve en 443 permanezca privado

Guardar el estado previo para compararlo después:

```bash
RUN_DIR="$(mktemp -d /tmp/clickup-funnel.XXXXXX)"
chmod 700 "$RUN_DIR"

sudo tailscale serve status --json > "$RUN_DIR/serve-before.json"
sudo tailscale funnel status --json > "$RUN_DIR/funnel-before.json"

jq -e '.TCP["443"].HTTPS == true' "$RUN_DIR/serve-before.json" >/dev/null
jq -e '.TCP["8443"] == null' "$RUN_DIR/serve-before.json" >/dev/null
```

No ejecutar `tailscale serve reset`, `tailscale funnel reset` ni configurar Funnel en `443`: esos comandos podrían borrar o volver público el servicio privado existente.

### GATE 2 — aislamiento

El estado de Serve debe mostrar HTTPS privado en `443` y ninguna entrada Serve en `8443`.

## 3. Validar estados y preparar `.env`

Consultar la lista real sin guardar ni imprimir el token:

```bash
curl --fail --silent --show-error \
  --header "Authorization: $CLICKUP_API_TOKEN" \
  "https://api.clickup.com/api/v2/list/$CLICKUP_HANDOFF_LIST_ID" \
  --output "$RUN_DIR/clickup-list.json"

jq -r '.statuses[] | [.status, .type] | @tsv' \
  "$RUN_DIR/clickup-list.json"
```

En la configuración verificada para este proyecto, los valores son:

```dotenv
CLICKUP_STATUS_ACKNOWLEDGED="in progress"
CLICKUP_STATUS_RESOLVED="complete"
```

Actualizar además la base pública que n8n debe mostrar:

```dotenv
WEBHOOK_URL=https://<TAILSCALE_HOSTNAME>:8443/
```

`<TAILSCALE_HOSTNAME>` se obtiene en el paso 5. Los valores con espacios deben permanecer entre comillas porque los scripts del repositorio ejecutan `. ./.env`.

### GATE 3 — estados

Los dos estados configurados deben existir exactamente en la respuesta de la lista. No continuar si fueron renombrados.

## 4. Crear y verificar un backup

```bash
sh scripts/ops/backup-local.sh

# Seleccionar solo directorios con el sello de tiempo que crea backup-local.sh.
# Un `sort | tail -n 1` sobre todo `backups/` ordena lexicograficamente y elige
# nombres como `runtime-repair-...` por encima de cualquier backup reciente.
BACKUP_DIR="$(find backups -mindepth 1 -maxdepth 1 -type d \
  -regextype posix-extended -regex '.*/[0-9]{8}-[0-9]{6}' | sort | tail -n 1)"
test -n "$BACKUP_DIR"
sh scripts/ops/verify-backup-local.sh "$BACKUP_DIR"

SNAPSHOT_DIR="backups/n8n-workflows-pre-clickup-$(date +%Y%m%d-%H%M%S)"
scripts/dev/sync-n8n-workflows.sh --snapshot "$SNAPSHOT_DIR"
test -d "$SNAPSHOT_DIR"
```

Registrar `BACKUP_DIR` y `SNAPSHOT_DIR` en la bitácora de la intervención.

### GATE 4 — recuperación

Continuar solo si `verify-backup-local.sh` finaliza correctamente y el snapshot contiene los workflows exportados.

## 5. Habilitar Funnel únicamente en 8443

Si el tailnet todavía no tiene Funnel habilitado, este comando **no falla: se queda bloqueado** esperando la aprobación, e imprime una URL con esta forma:

```
Funnel is not enabled on your tailnet.
To enable, visit:
     https://login.tailscale.com/f/funnel?node=<NODE_ID>
```

Esa aprobación es una acción manual en el navegador y agrega el atributo `funnel` a la **política del tailnet**, no solo a este nodo: a partir de ahí cualquier nodo con ese atributo puede publicar. No expone nada por sí sola — sigue haciendo falta un `tailscale funnel` explícito por puerto. Aprobar y volver a ejecutar el comando, que entonces resuelve en segundos.

No canalizar la salida de este comando a `tail` ni a otro filtro que buffee: oculta la URL de autorización y el bloqueo parece un cuelgue sin causa.

```bash
sudo tailscale funnel \
  --bg \
  --https=8443 \
  --set-path="$PUBLIC_PATH" \
  "$BACKEND_URL"
```

Obtener el hostname desde el estado local, sin copiarlo manualmente:

```bash
sudo tailscale funnel status --json > "$RUN_DIR/funnel-after.json"

export TAILSCALE_HOSTNAME="$({
  jq -r '.Web | keys[]' "$RUN_DIR/funnel-after.json"
} | sed -n 's/:8443$//p' | head -n 1)"

test -n "$TAILSCALE_HOSTNAME"
export CLICKUP_ENDPOINT="https://${TAILSCALE_HOSTNAME}:8443${PUBLIC_PATH}"
printf 'Endpoint público: %s\n' "$CLICKUP_ENDPOINT"
```

Comprobar que existe un único handler público en `8443` y que Serve `443` no cambió:

```bash
jq -e --arg key "$TAILSCALE_HOSTNAME:8443" --arg path "$PUBLIC_PATH" '
  .TCP["8443"].HTTPS == true
  and (.Web[$key].Handlers | keys) == [$path]
' "$RUN_DIR/funnel-after.json" >/dev/null

sudo tailscale serve status --json > "$RUN_DIR/serve-after.json"

# `serve status` y `funnel status` devuelven el mismo documento completo, asi que
# tras habilitar Funnel el "after" incluye 8443 y comparar el JSON entero fallaria
# siempre. Comparar unicamente la porcion de 443, que es la que debe quedar intacta.
SERVE_443_SLICE='{tcp443: .TCP["443"], web443: (.Web // {} | with_entries(select(.key | endswith(":443"))))}'
jq -S "$SERVE_443_SLICE" "$RUN_DIR/serve-before.json" > "$RUN_DIR/slice-before.json"
jq -S "$SERVE_443_SLICE" "$RUN_DIR/serve-after.json"  > "$RUN_DIR/slice-after.json"
cmp "$RUN_DIR/slice-before.json" "$RUN_DIR/slice-after.json"

# Y confirmar que 8443 es la unica entrada publica del nodo.
jq -e --arg key "$TAILSCALE_HOSTNAME:8443" \
  '(.AllowFunnel // {} | keys) == [$key]' \
  "$RUN_DIR/serve-after.json" >/dev/null
```

Una petición sin firma debe llegar a n8n cuando el workflow esté activo y responder `401`; antes de activarlo puede responder `404`. Ninguna otra ruta debe estar publicada por Funnel.

### GATE 5 — exposición mínima

Continuar solo si Funnel contiene exactamente `PUBLIC_PATH` en `8443` y el JSON de Serve `443` es idéntico al estado previo.

## 6. Importar el workflow inactivo

Verificar primero que no exista una copia runtime con el mismo nombre:

```bash
EXISTING_COUNT="$(docker compose --env-file .env exec -T postgres sh -lc \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At' <<'SQL'
SELECT count(*)
FROM workflow_entity
WHERE name = 'OPS - Handoff ClickUp Closure';
SQL
)"

test "$EXISTING_COUNT" = '0' || {
  printf 'El workflow ya existe en runtime; detener para evitar duplicados.\n' >&2
  exit 1
}

jq 'del(.id) | .active = false' \
  "$WORKFLOW_FILE" > "$RUN_DIR/ops-handoff-clickup-closure.import.json"

docker compose --env-file .env cp \
  "$RUN_DIR/ops-handoff-clickup-closure.import.json" \
  n8n:/tmp/ops-handoff-clickup-closure.json

docker compose --env-file .env exec -T -u node n8n \
  n8n import:workflow --input=/tmp/ops-handoff-clickup-closure.json

WORKFLOW_ID="$(docker compose --env-file .env exec -T postgres sh -lc \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At' <<'SQL'
SELECT id
FROM workflow_entity
WHERE name = 'OPS - Handoff ClickUp Closure';
SQL
)"

test -n "$WORKFLOW_ID"
docker compose --env-file .env exec -T -u node n8n \
  n8n update:workflow --id="$WORKFLOW_ID" --active=false

docker compose --env-file .env exec -T postgres sh -lc \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At' <<'SQL'
SELECT name, active
FROM workflow_entity
WHERE name = 'OPS - Handoff ClickUp Closure';
SQL
```

### GATE 6 — importación pausada

Debe existir exactamente una fila y su valor `active` debe ser `f`. No registrar el webhook si el workflow quedó activo accidentalmente.

## 7. Registrar el webhook en ClickUp sin mostrar el secreto

Durante esta ventana no se deben cambiar estados de tareas reales en la lista. El siguiente `POST` crea una integración externa y ClickUp devuelve el secreto una sola vez en la respuesta.

```bash
jq -n \
  --arg endpoint "$CLICKUP_ENDPOINT" \
  --arg list_id "$CLICKUP_HANDOFF_LIST_ID" \
  '{
    endpoint: $endpoint,
    events: ["taskStatusUpdated"],
    list_id: ($list_id | tonumber)
  }' > "$RUN_DIR/create-webhook-request.json"

HTTP_CODE="$(curl --silent --show-error \
  --request POST \
  --header "Authorization: $CLICKUP_API_TOKEN" \
  --header 'Content-Type: application/json' \
  --data-binary "@$RUN_DIR/create-webhook-request.json" \
  --output "$RUN_DIR/create-webhook-response.json" \
  --write-out '%{http_code}' \
  "https://api.clickup.com/api/v2/team/$CLICKUP_TEAM_ID/webhook")"

test "$HTTP_CODE" = '200'
jq -e '
  (.webhook.id | type == "string" and length > 0)
  and (.webhook.secret | type == "string" and length > 0)
' "$RUN_DIR/create-webhook-response.json" >/dev/null
```

Guardar `CLICKUP_WEBHOOK_ID` y `CLICKUP_WEBHOOK_SECRET` en `.env` mediante un proceso que no los imprime:

```bash
ENV_FILE="$PWD/.env" \
RESPONSE_FILE="$RUN_DIR/create-webhook-response.json" \
python3 <<'PY'
import json
import os
import shlex
from pathlib import Path

env_path = Path(os.environ['ENV_FILE'])
response_path = Path(os.environ['RESPONSE_FILE'])
webhook = json.loads(response_path.read_text())['webhook']

updates = {
    'CLICKUP_WEBHOOK_ID': shlex.quote(str(webhook['id'])),
    'CLICKUP_WEBHOOK_SECRET': shlex.quote(str(webhook['secret'])),
}

lines = env_path.read_text().splitlines()
seen = set()
result = []
for line in lines:
    key = line.split('=', 1)[0] if '=' in line else None
    if key in updates:
        result.append(f'{key}={updates[key]}')
        seen.add(key)
    else:
        result.append(line)
for key, value in updates.items():
    if key not in seen:
        result.append(f'{key}={value}')

temporary = env_path.with_name(env_path.name + '.tmp')
temporary.write_text('\n'.join(result) + '\n')
os.chmod(temporary, 0o600)
os.replace(temporary, env_path)
os.chmod(env_path, 0o600)
PY

chmod 600 .env "$RUN_DIR/create-webhook-response.json"
unset CLICKUP_WEBHOOK_SECRET CLICKUP_WEBHOOK_ID
```

No ejecutar `cat`, `jq .`, `set -x` ni comandos equivalentes sobre `.env` o la respuesta de creación.

### GATE 7 — registro restringido

Comprobar sin mostrar el secreto que ClickUp registró exactamente el endpoint, evento y lista esperados:

```bash
set -a
. ./.env
set +a

curl --fail --silent --show-error \
  --header "Authorization: $CLICKUP_API_TOKEN" \
  "https://api.clickup.com/api/v2/team/$CLICKUP_TEAM_ID/webhook" \
  --output "$RUN_DIR/webhooks.json"

jq -e \
  --arg id "$CLICKUP_WEBHOOK_ID" \
  --arg endpoint "$CLICKUP_ENDPOINT" \
  --arg list_id "$CLICKUP_HANDOFF_LIST_ID" '
  any(.webhooks[];
    .id == $id
    and .endpoint == $endpoint
    and .events == ["taskStatusUpdated"]
    and (.list_id | tostring) == $list_id)
' "$RUN_DIR/webhooks.json" >/dev/null
```

## 8. Configurar n8n, recrear el servicio y activar

Actualizar `.env` con el hostname y los estados validados:

```dotenv
WEBHOOK_URL=https://<TAILSCALE_HOSTNAME>:8443/
CLICKUP_STATUS_ACKNOWLEDGED="in progress"
CLICKUP_STATUS_RESOLVED="complete"
```

Validar la resolución de Compose sin volcar la configuración completa, que contendría secretos:

```bash
docker compose --env-file .env config --quiet
```

Recrear solamente n8n para inyectar el nuevo secreto:

```bash
docker compose --env-file .env up -d --no-deps --force-recreate n8n

until curl --fail --silent --show-error \
  http://127.0.0.1:5678/healthz >/dev/null; do
  sleep 2
done

docker compose --env-file .env exec -T n8n sh -lc '
  test -n "$CLICKUP_WEBHOOK_SECRET"
  test "$CLICKUP_STATUS_ACKNOWLEDGED" = "in progress"
  test "$CLICKUP_STATUS_RESOLVED" = "complete"
'

docker compose --env-file .env exec -T -u node n8n \
  n8n update:workflow --id="$WORKFLOW_ID" --active=true
docker compose --env-file .env restart n8n
```

Confirmar activación y registro de la ruta:

```bash
docker compose --env-file .env exec -T postgres sh -lc \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At' <<'SQL'
SELECT w.name, w.active, we.method, we."webhookPath"
FROM workflow_entity w
LEFT JOIN webhook_entity we ON we."workflowId" = w.id
WHERE w.name = 'OPS - Handoff ClickUp Closure';
SQL
```

### GATE 8 — listo para aceptación

El workflow debe estar activo, n8n debe estar sano y `webhook_entity` debe contener el método `POST` y la ruta de cierre.

## 9. Pruebas de aceptación

### 9.1 Firma ausente o inválida

Esta prueba produce una ejecución n8n, pero no debe modificar la base:

```bash
HTTP_CODE="$(curl --silent --show-error \
  --request POST \
  --header 'Content-Type: application/json' \
  --data '{"event":"taskStatusUpdated","task_id":"invalid-contract-test"}' \
  --output "$RUN_DIR/unauthorized-response.json" \
  --write-out '%{http_code}' \
  "$CLICKUP_ENDPOINT")"

test "$HTTP_CODE" = '401'
jq -e '.status == "unauthorized"' \
  "$RUN_DIR/unauthorized-response.json" >/dev/null
```

### 9.2 Evento real controlado

> **AUTORIZACIÓN EXPLÍCITA OBLIGATORIA:** mover una tarea real genera tráfico ClickUp → Funnel → n8n y puede cambiar `handoffs.estado` o cerrar la conversación asociada. Usar exclusivamente una tarea de prueba que ya esté vinculada a un handoff controlado.

1. Registrar el ID de la tarea controlada y el estado previo del handoff.
2. Cambiar la tarea a `in progress`.
3. Confirmar `notified → acknowledged` y una respuesta HTTP `200`.
4. Cambiar la misma tarea a `complete`.
5. Confirmar `acknowledged → resolved` y el cierre de la conversación solo si estaba en `escalation_required`.
6. Repetir el último evento o alternar estados fuera de orden y confirmar idempotencia: nunca debe ocurrir `resolved → acknowledged`.

Consultar evidencia sin exponer teléfono ni contenido del cliente:

```bash
HANDOFF_ID='<CONTROLLED_HANDOFF_ID>'
APP_POSTGRES_DB="${APP_POSTGRES_DB:-crm_whatsapp_app}"

docker compose --env-file .env exec -T postgres \
  psql -U "$POSTGRES_USER" -d "$APP_POSTGRES_DB" \
  -v ON_ERROR_STOP=1 -v handoff_id="$HANDOFF_ID" <<'SQL'
SELECT h.id, h.estado, h.notified_at, h.acknowledged_at, h.resolved_at
FROM handoffs h
WHERE h.id = :'handoff_id'::bigint;

SELECT result, metadata, created_at
FROM audit_logs
WHERE event_name = 'handoff_transition'
  AND entity_id = :'handoff_id'::bigint
ORDER BY created_at DESC
LIMIT 10;
SQL
```

Sustituir `<CONTROLLED_HANDOFF_ID>` únicamente en la sesión operativa; no pegar identificadores sensibles en documentos, tickets o memoria.

### GATE 9 — aceptación completa

- Petición no firmada: `401`, sin mutación.
- Evento real firmado: `200` y transición esperada.
- Duplicado: idempotente.
- Evento fuera de orden: no degrada `resolved` a `acknowledged`.
- No se expusieron rutas adicionales, secretos ni datos personales.
- n8n, PostgreSQL, Redis y Evolution permanecen sanos.

## 10. Observabilidad

Durante las primeras 24 horas:

```bash
sudo tailscale funnel status
docker compose --env-file .env ps
docker compose --env-file .env logs --since=15m --tail=200 n8n
```

Revisar en n8n las ejecuciones de `OPS - Handoff ClickUp Closure` y alertar ante:

- respuestas `401` sostenidas de ClickUp;
- `clickup_webhook_secret_not_configured` o `invalid_signature`;
- estados `unmapped_status:*`;
- resultados `unknown_task` o `invalid_transition`;
- aumento anormal de solicitudes o ejecuciones.

No registrar headers completos, `.env`, el body de creación del webhook ni la respuesta que contiene `webhook.secret`.

## 11. Rollback

Ejecutar el rollback ante fallos de firma real, transiciones incorrectas, exposición adicional o degradación del stack.

### 11.1 Detener eventos externos

Eliminar primero el webhook de ClickUp:

```bash
set -a
. ./.env
set +a

HTTP_CODE="$(curl --silent --show-error \
  --request DELETE \
  --header "Authorization: $CLICKUP_API_TOKEN" \
  --output "$RUN_DIR/delete-webhook-response.json" \
  --write-out '%{http_code}' \
  "https://api.clickup.com/api/v2/webhook/$CLICKUP_WEBHOOK_ID")"

test "$HTTP_CODE" = '200'
```

### 11.2 Desactivar el workflow y Funnel

```bash
docker compose --env-file .env exec -T -u node n8n \
  n8n update:workflow --id="$WORKFLOW_ID" --active=false
docker compose --env-file .env restart n8n

sudo tailscale funnel \
  --https=8443 \
  --set-path="$PUBLIC_PATH" \
  off

sudo tailscale funnel status --json > "$RUN_DIR/funnel-rollback.json"
sudo tailscale serve status --json > "$RUN_DIR/serve-rollback.json"

# Misma porcion de 443 que se comparo en el paso 5: debe volver a su estado original.
# Se redefine aqui porque el rollback puede ejecutarse en una shell nueva.
SERVE_443_SLICE='{tcp443: .TCP["443"], web443: (.Web // {} | with_entries(select(.key | endswith(":443"))))}'
jq -S "$SERVE_443_SLICE" "$RUN_DIR/serve-rollback.json" > "$RUN_DIR/slice-rollback.json"

# `slice-before.json` solo existe si `$RUN_DIR` sobrevivio a la intervencion. Si se
# perdio, omitir esta comparacion y validar 443 contra la configuracion esperada:
# HTTPS activo y un unico handler privado hacia el backend documentado.
test -f "$RUN_DIR/slice-before.json" \
  && cmp "$RUN_DIR/slice-before.json" "$RUN_DIR/slice-rollback.json"

# Y 8443 debe desaparecer por completo, tanto del Serve como de lo publicado.
jq -e '.TCP["8443"] == null' "$RUN_DIR/serve-rollback.json" >/dev/null
jq -e '(.AllowFunnel // {}) | length == 0' "$RUN_DIR/serve-rollback.json" >/dev/null
```

### 11.3 Restaurar workflows si la importación dañó el runtime

Restaurar el snapshot solo si desactivar/eliminar el workflow no es suficiente:

```bash
scripts/dev/sync-n8n-workflows.sh --rollback "$SNAPSHOT_DIR"
```

El rollback de ese script deja `WA - Inbound Entry` y `WA - Inbound Recovery` pausados por seguridad. Seguir su salida y la política operativa del repositorio antes de reactivarlos.

Finalmente, retirar `CLICKUP_WEBHOOK_ID` y `CLICKUP_WEBHOOK_SECRET` obsoletos de `.env`, conservar el archivo en modo `600` y eliminar el directorio temporal:

```bash
chmod 600 .env
rm -rf "$RUN_DIR"
```

### GATE 10 — rollback verificado

- El webhook ya no existe en ClickUp.
- Funnel no publica la ruta en `8443`.
- Serve `443` conserva su configuración original.
- El workflow está inactivo o el snapshot fue restaurado.
- El resto del stack está sano.

## Referencias oficiales

- [Tailscale Funnel](https://tailscale.com/docs/features/tailscale-funnel)
- [Comando `tailscale funnel`](https://tailscale.com/docs/reference/tailscale-cli/funnel)
- [Crear un webhook en ClickUp](https://developer.clickup.com/reference/createwebhook)
- [Firma de webhooks de ClickUp](https://developer.clickup.com/docs/webhooksignature)
- [Eliminar un webhook de ClickUp](https://developer.clickup.com/reference/deletewebhook)
