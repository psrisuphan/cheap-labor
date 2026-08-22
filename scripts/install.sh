#!/usr/bin/env bash
set -euo pipefail

# --------------------------------------------------------------------------- #
# cheap-labor — all-in-one installer
#
# The bridge runs locally (stdio) and reaches ChatGPT through OpenAI's Secure
# MCP Tunnel — the ONLY supported route. You use it in normal Chat on
# chatgpt.com (regular ChatGPT usage), where the tunnel appears as a
# developer-mode app connection. The local desktop-app registration
# (~/.codex/config.toml) is retired: this installer removes it if found.
#
# The installer: opens with a preparation stage that shows where to create
# your tunnel id + runtime API key and waits for you to have them ready, then
# checks prerequisites, installs deps, builds the bridge, removes any legacy
# desktop registration, collects the credentials, writes the tunnel-client
# profile, and validates the bridge over MCP stdio.
#
# Project access is managed inside the ChatGPT session: the user @-mentions
# cheap-labor, confirms a project, and the bridge issues a per-chat token.
# No project configuration happens here.
#
# Usage: ./scripts/install.sh [--skip-build]
#   Non-interactive: TUNNEL_ID=tunnel_... CONTROL_PLANE_API_KEY=sk-... ./scripts/install.sh
# --------------------------------------------------------------------------- #

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; DIM='\033[2m'; BOLD='\033[1m'; RESET='\033[0m'
pass()  { printf "${GREEN}  ✔ %s${RESET}\n" "$*"; }
warn()  { printf "${YELLOW}  ⚠ %s${RESET}\n" "$*"; }
fail()  { printf "${RED}  ✘ %s${RESET}\n" "$*"; exit 1; }
info()  { printf "${CYAN}  ℹ %s${RESET}\n" "$*"; }
note()  { printf "${DIM}  • %s${RESET}\n" "$*"; }
step()  { printf "\n${CYAN}─────────────────────────────────────────────${RESET}\n${BOLD}  ▶ %s${RESET}\n" "$*"; }
hr()    { printf "\n${CYAN}─────────────────────────────────────────────${RESET}\n"; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ENTRY="$PROJECT_DIR/dist/index.js"
CODEX_CONFIG_DIR="${CODEX_HOME:-$HOME/.codex}"
CODEX_CONFIG="$CODEX_CONFIG_DIR/config.toml"
SERVER_TABLE="mcp_servers.cheap-labor"

SKIP_BUILD=false

for arg in "$@"; do
  case "$arg" in
    --skip-build) SKIP_BUILD=true ;;
    --help|-h)
      echo "Usage: $0 [--skip-build]"
      echo ""
      echo "  --skip-build   Skip npm install and build (for re-runs)."
      echo ""
      echo "Non-interactive: TUNNEL_ID=tunnel_... CONTROL_PLANE_API_KEY=sk-... $0"
      exit 0 ;;
    *) warn "Unknown argument: $arg" ;;
  esac
done

printf "\n${CYAN}cheap-labor — all-in-one installer${RESET} ${DIM}(ChatGPT Chat on the web)${RESET}\n"

# ─── Preparation: get the credentials ready ───────────────────────────────── #
step "Preparation — get these ready (browser, one time)"
note "Tunnel id       → platform.openai.com/settings/organization/tunnels"
note "Runtime API key → platform.openai.com/settings/organization/api-keys (starts with sk-)"
if [ -t 0 ]; then
  printf "  ${CYAN}Press Enter${RESET} when both are ready to start (or Ctrl-C to abort): "
  read -r _ || true
  echo
fi
pass "Preparation done"

# ─── Step 1: Prerequisites ────────────────────────────────────────────────── #
step "1/6 · Prerequisites"

if command -v node &>/dev/null; then
  NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
  if [ "$NODE_VER" -ge 20 ]; then
    pass "Node.js $(node -v) (≥ 20 required)"
  else
    warn "Node.js $(node -v) found — version 20+ recommended"
  fi
else
  fail "Node.js not found. Install via: https://nodejs.org (or: brew install node)"
fi

if command -v npm &>/dev/null; then
  pass "npm $(npm -v)"
else
  fail "npm not found."
fi

if command -v codex &>/dev/null; then
  CODEX_VER=$(codex --version 2>/dev/null || echo "unknown")
  pass "Codex CLI ($CODEX_VER)"
  LOGIN_OUT=$(codex login status 2>&1 || true)
  if echo "$LOGIN_OUT" | grep -qi "logged in"; then
    pass "Codex logged in"
  else
    warn "Codex not logged in."
    info "Running: codex login (sign in with your ChatGPT account)…"
    codex login || warn "Login failed or was cancelled — deep_explore/implement won't work until then."
  fi
else
  warn "Codex CLI not found — bridge works, but deep_explore/implement won't."
  info "Install Codex: https://github.com/openai/codex  (npm install -g @openai/codex)"
fi

# ─── Step 2: Install dependencies ─────────────────────────────────────────── #
step "2/6 · Installing dependencies"
if [ "$SKIP_BUILD" = true ]; then
  note "--skip-build: skipping npm install"
else
  (cd "$PROJECT_DIR" && npm install 2>/dev/null)
  pass "Dependencies installed"
fi

# ─── Step 3: Build ────────────────────────────────────────────────────────── #
step "3/6 · Building"
if [ "$SKIP_BUILD" = true ]; then
  note "--skip-build: skipping build"
else
  (cd "$PROJECT_DIR" && npm run build)
  pass "Build complete — dist/index.js"
fi
[ -f "$ENTRY" ] || fail "dist/index.js missing — run without --skip-build first"

# ─── Step 4: Retire the old desktop-app registration (legacy cleanup) ────── #
step "4/6 · Legacy desktop-app cleanup"

if [ -f "$CODEX_CONFIG" ] && grep -q "^\[$SERVER_TABLE\]" "$CODEX_CONFIG"; then
  cp "$CODEX_CONFIG" "$CODEX_CONFIG.bak"
  awk -v table="[$SERVER_TABLE]" '
    index($0, table) == 1 { skip = 1; next }
    skip && index($0, "[") == 1 { skip = 0 }
    skip { next }
    index($0, "# Added by cheap-labor installer") == 1 { next }
    { keep[n++] = $0 }
    END {
      while (n > 0 && keep[n-1] == "") n--;
      for (i = 0; i < n; i++) print keep[i];
    }
  ' "$CODEX_CONFIG.bak" > "$CODEX_CONFIG.tmp" && mv "$CODEX_CONFIG.tmp" "$CODEX_CONFIG"
  if grep -q "^\[$SERVER_TABLE\]" "$CODEX_CONFIG"; then
    warn "Could not remove the old section — restore with: mv \"$CODEX_CONFIG.bak\" \"$CODEX_CONFIG\""
  else
    pass "Removed [$SERVER_TABLE] (backup: $CODEX_CONFIG.bak)"
  fi
else
  pass "No legacy registration found — nothing to remove"
fi

# ─── Step 5: Secure MCP Tunnel (required — the main connection) ──────────── #
step "5/6 · Secure MCP Tunnel (required)"

TUNNEL_ID_IN="${TUNNEL_ID:-}"
CONTROL_PLANE_API_KEY_IN="${CONTROL_PLANE_API_KEY:-}"

if [ ! -t 0 ]; then
  if [ -z "$TUNNEL_ID_IN" ] || [ -z "$CONTROL_PLANE_API_KEY_IN" ]; then
    fail "Non-interactive run needs both credentials:
  TUNNEL_ID=tunnel_... CONTROL_PLANE_API_KEY=sk-... ./scripts/install.sh"
  fi
fi

if [ -z "$TUNNEL_ID_IN" ]; then
  while [ -z "$TUNNEL_ID_IN" ]; do
    printf "  ${CYAN}Tunnel id${RESET} (created in the preparation step; e.g. tunnel_...): "
    read -r TUNNEL_ID_IN || true
    case "$TUNNEL_ID_IN" in
      tunnel_*) break ;;
      *) warn "That doesn't look right — a tunnel id starts with 'tunnel_'."; TUNNEL_ID_IN="" ;;
    esac
  done
fi
pass "Tunnel id accepted"

if [ -z "$CONTROL_PLANE_API_KEY_IN" ]; then
  while [ -z "$CONTROL_PLANE_API_KEY_IN" ]; do
    printf "  ${CYAN}Runtime API key${RESET} (created in the preparation step; e.g. sk-...; input is hidden): "
    read -rs CONTROL_PLANE_API_KEY_IN || true
    echo
    case "$CONTROL_PLANE_API_KEY_IN" in
      sk-*) break ;;
      *) warn "That doesn't look right — an API key starts with 'sk-'."; CONTROL_PLANE_API_KEY_IN="" ;;
    esac
  done
fi
pass "Runtime API key accepted"

TUNNEL_ID="$TUNNEL_ID_IN" CONTROL_PLANE_API_KEY="$CONTROL_PLANE_API_KEY_IN" \
  "$SCRIPT_DIR/tunnel-setup.sh"

# ─── Step 6: Validate ─────────────────────────────────────────────────────── #
step "6/6 · Validation"

TOOL_COUNT=$(node -e "
  const { spawn } = require('node:child_process');
  const child = spawn('node', ['$ENTRY'], { stdio: ['pipe','pipe'] });
  let buf = '';
  child.stdout.on('data', d => {
    buf += d.toString();
    try {
      for (const l of buf.split('\n')) {
        if (!l.trim()) continue;
        const m = JSON.parse(l);
        if (m.id === 2) { console.log(m.result.tools.length); child.kill(); process.exit(0); }
      }
    } catch {}
  });
  child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'installer',version:'1'}}})+'\n');
  setTimeout(() => { process.exit(1); }, 10000);
  setTimeout(() => { child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/list',params:{}})+'\n'); }, 200);
" 2>/dev/null || echo "ERR")
if [ "$TOOL_COUNT" = "25" ]; then
  pass "Bridge validates: 25 tools served over MCP stdio"
elif [ "$TOOL_COUNT" = "ERR" ]; then
  warn "Could not validate (timeout). Bridge may still work fine in ChatGPT."
else
  warn "Expected 25 tools, got $TOOL_COUNT"
fi

# ─── Summary ──────────────────────────────────────────────────────────────── #
hr
printf "${GREEN}Installation complete.${RESET}\n\n"

printf "${BOLD}Finish the connection (one time)${RESET}\n"
printf "  1. ▶ Start the tunnel daemon — keep it running while you chat:\n"
printf "       ./scripts/tunnel.sh start\n"
printf "     (stop it anytime with: ./scripts/tunnel.sh stop)\n"
printf "  2. ▶ Create the app: chatgpt.com/plugins\n"
printf "     • plus button → Connection: Tunnel → select your tunnel → Create\n"
printf "     • developer mode must be on (Settings → Security and login)\n"
printf "     • use the same ChatGPT workspace the tunnel was created in, or it\n"
printf "       won't show in the picker\n"
printf "  3. ▶ New chat → add the connection from the tools menu → type:\n"
printf "       @cheap-labor\n"
printf "     confirm the project path — the session is armed.\n\n"

printf "${BOLD}Tips${RESET}\n"
printf "  • App missing from the @ menu? Hard-refresh (Cmd+Opt+R) or new chat → re-add.\n"
printf "  • While dormant the bridge costs the model nothing; the full workflow\n"
printf "    rules load when the session is armed.\n\n"
