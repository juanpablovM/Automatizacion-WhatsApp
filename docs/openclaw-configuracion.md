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
5. Probar fallos: token ausente, bridge caido, respuesta invalida y baja confianza.
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

## Reglas para evitar conflictos de versiones

- Mantener `AI_PROVIDER=openclaw` y `OPENCLAW_AGENT=hormi-atencion` como valores compartidos del proyecto.
- No reintroducir proveedores AI antiguos en `.env.example`, `docker-compose.yml`, workflows ni documentacion operativa.
- Mantener la separacion de responsabilidades: Hormi Atencion decide la conversacion; n8n/PostgreSQL ejecutan persistencia, ClickUp y asignacion.
- No cambiar IDs o nombres de workflows manualmente dentro de n8n sin sincronizar desde `n8n/workflows/`.
- No commitear `.env`, tokens reales ni salidas que expongan secretos.
- Registrar cualquier cambio de prompt, autonomia o contrato JSON junto con pruebas locales y matriz conversacional.
