#!/usr/bin/env bash
set -euo pipefail

# --------------------------------------------------------------------------- #
# cheap-labor — Secure MCP Tunnel setup (the main connection path)
#
# The bridge reaches ChatGPT Chat on the web (normal ChatGPT usage) ONLY
# through OpenAI's Secure MCP Tunnel: tunnel-client runs on this Mac,
# long-polls OpenAI, and forwards MCP requests to the bridge over stdio — no
# public ports, no HTTP rewrite. Normally invoked by ./scripts/install.sh; run
# this standalone to re-create the profile after a tunnel/key change.
#
# Usage:
#   export CONTROL_PLANE_API_KEY="sk-..."          # Runtime API key
#   TUNNEL_ID="tunnel_..." ./scripts/tunnel-setup.sh  # tunnel id from Platform
#
# Credential sources (one time, in the browser):
#   1. Tunnel id:      https://platform.openai.com/settings/organization/tunnels
#   2. Runtime API key: https://platform.openai.com/settings/organization/api-keys
#   3. App connection:  https://chatgpt.com/plugins → plus → Connection: Tunnel
# --------------------------------------------------------------------------- #

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; DIM='\033[2m'; BOLD='\033[1m'; RESET='\033[0m'
pass() { printf "${GREEN}  ✔ %s${RESET}\n" "$*"; }
warn() { printf "${YELLOW}  ⚠ %s${RESET}\n" "$*"; }
fail() { printf "${RED}  ✘ %s${RESET}\n" "$*"; exit 1; }
info() { printf "${CYAN}  ℹ %s${RESET}\n" "$*"; }
note() { printf "${DIM}  • %s${RESET}\n" "$*"; }
step() { printf "\n${CYAN}─────────────────────────────────────────────${RESET}\n${BOLD}  ▶ %s${RESET}\n" "$*"; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENTRY="$SCRIPT_DIR/../dist/index.js"
PROFILE="cheap-labor"

TUNNEL_ID="${1:-${TUNNEL_ID:-}}"

step "Secure MCP Tunnel setup"

# ─── Step 1: bridge binary ───────────────────────────────────────────────── #
step "1/4 · Bridge binary"
[ -f "$ENTRY" ] || fail "dist/index.js missing — run ./scripts/install.sh (or npm run build) first"
pass "Bridge found: $ENTRY"

# ─── Step 2: tunnel-client ───────────────────────────────────────────────── #
step "2/4 · tunnel-client"
if command -v tunnel-client &>/dev/null; then
  pass "tunnel-client $(tunnel-client --version 2>/dev/null || echo installed)"
else
  info "Installing tunnel-client…"
  if command -v brew &>/dev/null && [ "$(uname)" = "Darwin" ]; then
    brew install openai/tools/tunnel-client
    pass "tunnel-client installed"
  else
    fail "tunnel-client not on PATH. Install it:
  macOS: brew install openai/tools/tunnel-client
  Linux: download the linux-amd64/arm64 binary from
         https://github.com/openai/tunnel-client/releases/latest
         and put it on your PATH, then re-run this script"
  fi
fi

# ─── Step 3: tunnel id + runtime API key ─────────────────────────────────── #
step "3/4 · Tunnel id + runtime API key"
if [ -z "$TUNNEL_ID" ]; then
  fail "Tunnel id missing. Create one at https://platform.openai.com/settings/organization/tunnels
then re-run: TUNNEL_ID=tunnel_... ./scripts/tunnel-setup.sh"
fi
case "$TUNNEL_ID" in tunnel_*) pass "Tunnel id: $TUNNEL_ID" ;; *) fail "Tunnel id must look like tunnel_… (got: $TUNNEL_ID)" ;; esac

if [ -z "${CONTROL_PLANE_API_KEY:-}" ]; then
  fail "CONTROL_PLANE_API_KEY missing. Create a runtime API key at
https://platform.openai.com/settings/organization/api-keys
then re-run with: export CONTROL_PLANE_API_KEY=sk-..."
fi
pass "Runtime API key present (CONTROL_PLANE_API_KEY)"

# ─── Step 4: profile ─────────────────────────────────────────────────────── #
step "4/4 · Profile + validation"
info "Writing profile '$PROFILE' (stdio → node $ENTRY)…"
PROFILE_DIR="${TUNNEL_CLIENT_PROFILE_DIR:-$HOME/.config/tunnel-client}"
KEYFILE="$PROFILE_DIR/$PROFILE.key"
mkdir -p "$PROFILE_DIR"
(umask 077 && printf '%s' "$CONTROL_PLANE_API_KEY" > "$KEYFILE")
chmod 600 "$KEYFILE"
ENTRY_ESC="${ENTRY//\"/\\\"}"
tunnel-client init \
  --sample sample_mcp_stdio_local \
  --profile "$PROFILE" \
  --force \
  --tunnel-id "$TUNNEL_ID" \
  --control-plane-api-key-ref "file:$KEYFILE" \
  --mcp-command "node \"$ENTRY_ESC\"" >/dev/null || fail "tunnel-client init failed — run it manually with --explain for details"
pass "Profile written (key stored at $KEYFILE, chmod 600)"

# ─── Step 5: doctor ──────────────────────────────────────────────────────── #
info "Validating with tunnel-client doctor…"
if DOCTOR_OUT=$(tunnel-client doctor --profile "$PROFILE" 2>&1); then
  pass "tunnel-client doctor: all checks passed"
else
  warn "doctor reported issues:"
  printf "%s\n" "$DOCTOR_OUT"
fi

# ─── Summary ─────────────────────────────────────────────────────────────── #
printf "\n${GREEN}Tunnel setup complete.${RESET}\n\n"

printf "${BOLD}Next (no env vars needed)${RESET}\n"
printf "  1. ▶ Daemon — keep it running while you chat:\n"
printf "       ./scripts/tunnel.sh start   (stop: ./scripts/tunnel.sh stop)\n"
printf "  2. ▶ App: chatgpt.com/plugins → plus → Connection: Tunnel → select it.\n"
printf "     • Only tunnels associated with your current ChatGPT workspace\n"
printf "       appear here — pick the same workspace used when creating it.\n"
printf "  3. ▶ New chat → add the connection from the tools menu → type:\n"
printf "       @cheap-labor\n\n"

printf "${BOLD}Tips${RESET}\n"
printf "  • Troubleshooting: tunnel-client doctor --profile %s --explain\n" "$PROFILE"
printf "  • App missing from the @ menu? Hard-refresh (Cmd+Opt+R) or new chat → re-add.\n\n"
