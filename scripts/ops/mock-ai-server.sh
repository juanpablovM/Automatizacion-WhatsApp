#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
cd "$ROOT_DIR"

usage() {
  cat <<'EOF'
Uso:
  sh scripts/ops/mock-ai-server.sh [start|stop|status]

Mock HTTP server para simular el proveedor AI (Hormi Atencion).
Escucha en POST /chat/completions y responde segun el modo configurado.

Modos (via MOCK_AI_MODE env):
  valid           Responde JSON valido con campos PRD
  invalid_json    Responde texto no JSON
  low_confidence  Responde con confidence < 0.75
  timeout         No responde dentro del timeout normal

Variables de entorno:
  MOCK_AI_PORT    Puerto (default: 9999)
  MOCK_AI_HOST    Host de escucha (default: 0.0.0.0)
  MOCK_AI_MODE    Modo de respuesta (default: valid)
EOF
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "ERROR: falta dependencia '$1'" >&2
    exit 1
  fi
}

case "${1:-}" in
  -h|--help)
    usage
    exit 0
    ;;
esac

require_cmd node

MOCK_AI_PORT="${MOCK_AI_PORT:-9999}"
MOCK_AI_HOST="${MOCK_AI_HOST:-0.0.0.0}"
MOCK_AI_MODE="${MOCK_AI_MODE:-valid}"
PID_FILE="/tmp/mock-ai-server.pid"
LOG_FILE="/tmp/mock-ai-server.log"

start_server() {
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "ERROR: mock-ai-server ya esta corriendo (PID $(cat "$PID_FILE"))" >&2
    exit 1
  fi

  MOCK_AI_PORT="$MOCK_AI_PORT" MOCK_AI_HOST="$MOCK_AI_HOST" MOCK_AI_MODE="$MOCK_AI_MODE" \
    nohup setsid node scripts/ops/mock-ai-server.js >"$LOG_FILE" 2>&1 &
  echo "$!" > "$PID_FILE"
  sleep 0.5

  if ! kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "ERROR: mock-ai-server no pudo iniciar. Log:" >&2
    cat "$LOG_FILE" >&2 || true
    rm -f "$PID_FILE"
    exit 1
  fi

  echo "Mock AI server iniciado (PID $(cat "$PID_FILE"), modo $MOCK_AI_MODE, host $MOCK_AI_HOST, puerto $MOCK_AI_PORT)"
}

stop_server() {
  if [ ! -f "$PID_FILE" ]; then
    echo "ERROR: no hay PID guardado en $PID_FILE" >&2
    exit 1
  fi
  pid=$(cat "$PID_FILE")
  if kill "$pid" 2>/dev/null; then
    echo "Mock AI server detenido (PID $pid)"
  else
    echo "ERROR: no se pudo detener el proceso $pid" >&2
  fi
  rm -f "$PID_FILE"
}

status_server() {
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "mock-ai-server corriendo (PID $(cat "$PID_FILE"), puerto $MOCK_AI_PORT)"
  else
    echo "mock-ai-server no esta corriendo"
    if [ -f "$PID_FILE" ]; then
      rm -f "$PID_FILE"
    fi
  fi
}

case "${1:-}" in
  start)
    start_server
    ;;
  stop)
    stop_server
    ;;
  status)
    status_server
    ;;
  *)
    usage >&2
    exit 1
    ;;
esac
