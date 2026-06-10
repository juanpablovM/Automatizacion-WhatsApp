# OpenClaw Configuracion

## Estado actual

OpenClaw queda como la IA oficial del proyecto mediante el agente `hormi-atencion` (`Hormi Atencion`).

El repositorio ya versiona OpenClaw activado por defecto. El agente puede tomar decisiones conversacionales con mas autonomia, incluyendo habilitar la creacion de un lead cuando ya existen `servicio`, `ciudad`, `requerimiento`, confirmacion explicita del usuario y confianza suficiente.

La ejecucion tecnica sigue separada: Hormi Atencion decide y responde; `n8n`/PostgreSQL persisten estado, crean leads, sincronizan ClickUp y asignan vendedores.

## Fuente de verdad

- `AI_LEAD_ASSISTANT_ENABLED=true` queda versionado por defecto.
- `AI_PROVIDER=openclaw` queda versionado por defecto.
- El bridge local oficial es `scripts/ai/hormi-atencion-bridge.js`.
- El agente OpenClaw del proyecto es `hormi-atencion`.
- El nombre visible del agente es `Hormi Atencion`.

## Que ya existe

- Bridge HTTP local:
  - `GET /health`
  - `POST /api/evaluate`
- Autenticacion simple del bridge mediante `OPENCLAW_BRIDGE_TOKEN`.
- Soporte en `AI - Lead Qualification Assistant` para OpenClaw como proveedor unico versionado.
- Envio desde n8n hacia `OPENCLAW_BRIDGE_URL`.
- Sesion OpenClaw aislada por `conversation_id` o telefono cuando no se define `OPENCLAW_SESSION_KEY`.
- Normalizacion de respuesta OpenClaw desde `reply`, `payloads[].text` o texto final del agente.
- Pruebas locales mock en `scripts/ops/test-ai-assistant-local.sh`.

## Validaciones antes de produccion

1. Levantar el bridge con `OPENCLAW_AGENT=hormi-atencion`.
2. Validar que el agente responda siempre con el JSON esperado por `AI - Lead Qualification Assistant`.
3. Ejecutar la matriz conversacional con AI apagada como baseline comparativo.
4. Ejecutar la matriz conversacional con Hormi Atencion encendida.
5. Probar fallos: token ausente en el bridge, token ausente en `n8n`, bridge caido, respuesta invalida y baja confianza.
6. Documentar el resultado en `docs/matriz-pruebas-conversacionales.md` o en la bitacora operativa que corresponda.

## Variables esperadas

```env
AI_LEAD_ASSISTANT_ENABLED=true
AI_PROVIDER=openclaw
AI_API_KEY_REQUIRED=false
OPENCLAW_BRIDGE_URL=http://host.docker.internal:9090
OPENCLAW_BRIDGE_TOKEN=<redacted>
OPENCLAW_AGENT=hormi-atencion
OPENCLAW_SESSION_KEY=
OPENCLAW_MODEL=
OPENCLAW_TIMEOUT_SECONDS=25
```

Notas:

- `OPENCLAW_BRIDGE_TOKEN` debe existir tanto en el proceso del bridge como en `.env` para n8n.
- `OPENCLAW_MODEL` debe quedar vacio salvo que se necesite sobrescribir el modelo definido en OpenClaw.
- No commitear `.env` ni valores reales de token.
- El bridge debe correr en el host cuando se usa el binario global de OpenClaw. `n8n` corre en Docker y llega al host mediante `OPENCLAW_BRIDGE_URL=http://host.docker.internal:9090`.

## Arranque del bridge

```bash
OPENCLAW_BRIDGE_TOKEN=<redacted> \
OPENCLAW_AGENT=hormi-atencion \
node scripts/ai/hormi-atencion-bridge.js
```

Luego recrear n8n:

```bash
docker compose --env-file .env up -d n8n
```

Verificaciones minimas:

```bash
curl http://localhost:9090/health
docker compose exec -T n8n node -e "fetch('http://host.docker.internal:9090/health').then(async r=>console.log(r.status, await r.text()))"
scripts/ops/test-ai-assistant-local.sh
scripts/dev/sync-n8n-workflows.sh --preflight
```

## Diagnostico rapido sin secretos

Usar estos checks para confirmar configuracion sin imprimir tokens ni API keys:

```bash
node -e "const fs=require('fs'); const p='.env'; const s=fs.existsSync(p)?fs.readFileSync(p,'utf8'):''; const has=/^OPENCLAW_BRIDGE_TOKEN=.+/m.test(s); console.log('OPENCLAW_BRIDGE_TOKEN en .env:', has ? 'set' : 'missing')"
curl -sS http://localhost:9090/health
docker compose exec -T n8n node -e "fetch('http://host.docker.internal:9090/health').then(async r=>console.log(r.status, await r.text()))"
node -e "const fs=require('fs'); const p=process.env.HOME+'/.openclaw/openclaw.json'; const j=JSON.parse(fs.readFileSync(p,'utf8')); console.log('openclaw config:', fs.existsSync(p) ? 'exists' : 'missing'); console.log('agents:', (j.agents?.list||[]).map(a=>a.id).join(', ') || '(none)'); console.log('providers:', Object.keys(j.models?.providers||{}).join(', ') || '(none)')"
```

Interpretacion de autenticacion del bridge:

- `GET /health` con `auth_configured: true`: el proceso del bridge fue levantado con `OPENCLAW_BRIDGE_TOKEN`.
- `GET /health` con `auth_configured: false`: reiniciar el bridge exportando `OPENCLAW_BRIDGE_TOKEN`.
- `POST /api/evaluate` devuelve `503` con `OPENCLAW_BRIDGE_TOKEN is not configured`: falta el token en el proceso del bridge.
- `POST /api/evaluate` devuelve `401 unauthorized`: el bridge tiene token, pero el request no trae el mismo token. Revisar `.env`, recrear `n8n` y confirmar que el workflow manda `X-OpenClaw-Bridge-Token`.

## Reglas para evitar conflictos de versiones

- Mantener `AI_PROVIDER=openclaw` y `OPENCLAW_AGENT=hormi-atencion` como valores compartidos del proyecto.
- No reintroducir proveedores AI antiguos en `.env.example`, `docker-compose.yml`, workflows ni documentacion operativa.
- Mantener la separacion de responsabilidades: Hormi Atencion decide la conversacion; n8n/PostgreSQL ejecutan persistencia, ClickUp y asignacion.
- No cambiar IDs o nombres de workflows manualmente dentro de n8n sin sincronizar desde `n8n/workflows/`.
- No commitear `.env`, tokens reales ni salidas que expongan secretos.
- Registrar cualquier cambio de prompt, autonomia o contrato JSON junto con pruebas locales y matriz conversacional.
