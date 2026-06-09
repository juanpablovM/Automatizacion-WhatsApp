# OpenClaw Configuracion

## Estado actual

OpenClaw queda **preparado en el repositorio, pero no activado para operacion real**.

Motivo: el agente especializado para WhatsApp/Hormi Atencion ya fue creado con id `hormi-atencion`. Hasta que ese agente sea validado, el proyecto debe seguir tratando OpenClaw como una integracion disponible para pruebas controladas, no como proveedor activo de produccion.

## Fuente de verdad

- La AI sigue desactivada por defecto con `AI_LEAD_ASSISTANT_ENABLED=false`.
- El proveedor versionado por defecto sigue siendo NVIDIA MiniMax via NVIDIA NIM.
- OpenClaw es una ruta alternativa local, preparada mediante `scripts/ai/hormi-atencion-bridge.js`.
- El agente OpenClaw del proyecto es `hormi-atencion`.

## Que ya existe

- Bridge HTTP local:
  - `GET /health`
  - `POST /api/evaluate`
- Autenticacion simple del bridge mediante `OPENCLAW_BRIDGE_TOKEN`.
- Soporte en `AI - Lead Qualification Assistant` para `AI_PROVIDER=openclaw`.
- Envio desde n8n hacia `OPENCLAW_BRIDGE_URL`.
- Sesion OpenClaw aislada por `conversation_id` o telefono cuando no se define `OPENCLAW_SESSION_KEY`.
- Normalizacion de respuesta OpenClaw desde `reply` o `payloads[].text`.
- Pruebas locales mock en `scripts/ops/test-ai-assistant-local.sh`.

## Que falta antes de activar

1. Usar `OPENCLAW_AGENT=hormi-atencion`.
2. Validar que el agente responda siempre con el JSON esperado por `AI - Lead Qualification Assistant`.
3. Ejecutar la matriz conversacional con AI apagada.
4. Ejecutar la matriz conversacional con AI encendida y `AI_PROVIDER=openclaw`.
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

## Arranque controlado cuando el agente este listo

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

- No activar `AI_PROVIDER=openclaw` en `.env` compartidos hasta que el agente `hormi-atencion` este validado.
- No reemplazar la politica de AI controlada: OpenClaw recomienda, n8n/PostgreSQL deciden.
- No cambiar IDs o nombres de workflows manualmente dentro de n8n sin sincronizar desde `n8n/workflows/`.
- No documentar OpenClaw como proveedor productivo hasta que existan pruebas reales registradas para `hormi-atencion`.
- Mantener NVIDIA como proveedor documentado por defecto mientras `hormi-atencion` siga pendiente de validacion.
