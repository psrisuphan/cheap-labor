#!/usr/bin/env bash
set -euo pipefail

# --------------------------------------------------------------------------- #
# cheap-labor — tunnel daemon control
#
# Start/stop/check the tunnel-client daemon without remembering the raw
# command. The daemon keeps the bridge reachable from ChatGPT while you chat.
#
# Usage:
#   ./scripts/tunnel.sh start    start the daemon (background, logs to file)
#   ./scripts/tunnel.sh stop     stop the daemon
#   ./scripts/tunnel.sh restart  stop then start
#   ./scripts/tunnel.sh status   is it running?
#   ./scripts/tunnel.sh logs     tail the daemon log
#
# Note: this controls 'tunnel-client run' daemons. If you used
# 'tunnel-client runtimes connect' instead, stop it with:
#   tunnel-client runtimes stop cheap-labor
# --------------------------------------------------------------------------- #

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; DIM='\033[2m'; BOLD='\033[1m'; RESET='\033[0m'
pass()  { printf "${GREEN}  ✔ %s${RESET}\n" "$*"; }
warn()  { printf "${YELLOW}  ⚠ %s${RESET}\n" "$*"; }
fail()  { printf "${RED}  ✘ %s${RESET}\n" "$*"; exit 1; }
info()  { printf "${CYAN}  ℹ %s${RESET}\n" "$*"; }
note()  { printf "${DIM}  • %s${RESET}\n" "$*"; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROFILE="cheap-labor"
PROFILE_DIR="${TUNNEL_CLIENT_PROFILE_DIR:-$HOME/.config/tunnel-client}"
PROFILE_FILE="$PROFILE_DIR/$PROFILE.yaml"
PIDFILE="$PROFILE_DIR/$PROFILE.pid"
LOGFILE="$PROFILE_DIR/$PROFILE.log"
RUN_PATTERN="tunnel-client run --profile $PROFILE"

RUNNING_PID=""

is_running() {
  if [ -f "$PIDFILE" ]; then
    local pid
    pid=$(cat "$PIDFILE" 2>/dev/null || true)
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      RUNNING_PID="$pid"
      return 0
    fi
    rm -f "$PIDFILE"
  fi
  pgrep -f "$RUN_PATTERN" >/dev/null 2>&1
}

start() {
  if is_running; then
    warn "Already running (pid ${RUNNING_PID:-unknown})"
    return 0
  fi
  [ -f "$PROFILE_FILE" ] || fail "No tunnel profile — run ./scripts/install.sh (or ./scripts/tunnel-setup.sh) first"
  mkdir -p "$PROFILE_DIR"
  nohup tunnel-client run --profile "$PROFILE" >>"$LOGFILE" 2>&1 &
  echo $! >"$PIDFILE"
  sleep 1
  if is_running; then
    pass "Tunnel daemon started (pid $(cat "$PIDFILE"))"
    note "Logs: $LOGFILE"
    note "Stop anytime: ./scripts/tunnel.sh stop"
  else
    rm -f "$PIDFILE"
    fail "Daemon exited immediately — see: tail -20 $LOGFILE"
  fi
}

stop() {
  if [ -f "$PIDFILE" ]; then
    local pid
    pid=$(cat "$PIDFILE" 2>/dev/null || true)
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      for _ in 1 2 3 4 5; do
        kill -0 "$pid" 2>/dev/null || break
        sleep 1
      done
      kill -9 "$pid" 2>/dev/null || true
    fi
    rm -f "$PIDFILE"
  fi
  pkill -f "$RUN_PATTERN" 2>/dev/null || true
  pass "Tunnel daemon stopped"
  note "For 'tunnel-client runtimes connect' daemons: tunnel-client runtimes stop $PROFILE"
}

status() {
  if is_running; then
    pass "Tunnel daemon is running (pid ${RUNNING_PID:-?})"
    note "Logs: $LOGFILE"
  else
    warn "Tunnel daemon is NOT running"
    note "Start it: ./scripts/tunnel.sh start"
  fi
}

restart() {
  stop
  start
}

logs() {
  [ -f "$LOGFILE" ] && tail -n 50 "$LOGFILE" || note "No log yet — start the daemon first."
}

case "${1:-}" in
  start)   start ;;
  stop)    stop ;;
  restart) restart ;;
  status)  status ;;
  logs)    logs ;;
  help|-h|--help|"")
    echo "Usage: $0 {start|stop|restart|status|logs}"
    echo ""
    echo "  start    start the tunnel daemon in the background (logs to file)"
    echo "  stop     stop the daemon"
    echo "  restart  stop then start"
    echo "  status   show whether the daemon is running"
    echo "  logs     tail the daemon log"
    ;;
  *) warn "Unknown command: $1 (try: $0 help)" ; exit 1 ;;
esac