#!/usr/bin/env bash
# dodo_bridge_server 启动脚本（服务器侧）
# 用法：bash run_dodo_bridge.sh [start|stop|restart|status]
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/run_dodo_bridge.env"
PYTHON="$(command -v python3 || echo python3)"
PID_FILE="${HOME}/.dodo_napcat/dodo_bridge_server.pid"
LOG_FILE="${HOME}/.dodo_napcat/dodo_bridge_server.log"

if [ ! -f "${ENV_FILE}" ]; then
  echo "[dodo] env file not found: ${ENV_FILE} (copy from .env.example)" >&2
  exit 1
fi

load_env() {
  set -a
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  set +a
}

start() {
  if [ -f "${PID_FILE}" ] && kill -0 "$(cat "${PID_FILE}")" 2>/dev/null; then
    echo "[dodo] already running (pid $(cat "${PID_FILE}"))"
    return 0
  fi
  load_env
  mkdir -p "${HOME}/.dodo_napcat"
  nohup "${PYTHON}" "${SCRIPT_DIR}/dodo_bridge_server.py" >> "${LOG_FILE}" 2>&1 &
  echo $! > "${PID_FILE}"
  echo "[dodo] started pid $(cat "${PID_FILE}")"
}

stop() {
  if [ -f "${PID_FILE}" ] && kill -0 "$(cat "${PID_FILE}")" 2>/dev/null; then
    kill "$(cat "${PID_FILE}")" && rm -f "${PID_FILE}"
    echo "[dodo] stopped"
  else
    echo "[dodo] not running"
  fi
}

status() {
  load_env
  curl -s -m 3 "http://${LISTEN_HOST:-127.0.0.1}:${LISTEN_PORT:-8080}/health" || echo "unreachable"
}

case "${1:-start}" in
  start) start ;;
  stop) stop ;;
  restart) stop; sleep 1; start ;;
  status) status ;;
  *) echo "usage: $0 [start|stop|restart|status]" ;;
esac
