#!/usr/bin/env bash
set -euo pipefail

# --------------------------------------------------------------------------- #
# cheap-labor — uninstaller (interactive)
#
# Cleans up everything the script can reach:
#   1. Legacy MCP registration in ~/.codex/config.toml (old desktop route)
#   2. The tunnel-client daemon (stopped if running)
#   3. .codex-bridge/ state of every initialized project + the ledgers
#   4. The tunnel-client profile (~/.config/tunnel-client/)
#   5. Build artifacts (node_modules/, dist/)
#
# After the script finishes, a short manual guide is printed for the parts it
# cannot touch (ChatGPT app connection, Platform tunnel, API key, repo folder).
#
# Non-interactive runs (no TTY) use the recommended answers for every question.
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
CODEX_CONFIG_DIR="${CODEX_HOME:-$HOME/.codex}"
CODEX_CONFIG="$CODEX_CONFIG_DIR/config.toml"
SERVER_TABLE="mcp_servers.cheap-labor"
LEDGER="$CODEX_CONFIG_DIR/cheap-labor-approved-projects.json"
LEGACY_LEDGER="$CODEX_CONFIG_DIR/bridge-approved-projects.json"
TUNNEL_PROFILE_DIR="${TUNNEL_CLIENT_PROFILE_DIR:-$HOME/.config/tunnel-client}"
TUNNEL_PROFILE="$TUNNEL_PROFILE_DIR/cheap-labor.yaml"

# Ask a yes/no question. Default (used when the user just presses Enter, and
# for non-TTY runs) is "Y". Returns 0 for yes, 1 for no.
ask_yes() {
  local prompt="$1"
  if [ ! -t 0 ]; then
    return 0 # non-interactive → recommended answer (yes)
  fi
  while true; do
    printf "  %s [Y/n]: " "$prompt"
    read -r answer || true
    case "${answer:-Y}" in
      y|Y|yes|YES) return 0 ;;
      n|N|no|NO)   return 1 ;;
      *) warn "Please answer y or n." ;;
    esac
  done
}

# Purge .codex-bridge/ state for every path listed in a ledger file, unpin the
# bridge's git refs in each project, then delete the ledger file.
# Paths come from an editable JSON file, so each one is validated before any
# destructive step: it must be absolute, exist, and be a real directory.
purge_ledger() {
  local ledger="$1"
  local COUNT=0
  while IFS= read -r p; do
    [ -z "$p" ] && continue
    case "$p" in
      /*) ;;
      *) warn "Skipping non-absolute ledger path: $p" ; continue ;;
    esac
    [ -d "$p" ] || { warn "Skipping non-existent ledger path: $p" ; continue; }
    [ ! -L "$p" ] || { warn "Skipping symlinked ledger path: $p" ; continue; }
    if [ -d "$p/.codex-bridge" ]; then
      rm -rf "$p/.codex-bridge"
      pass "Deleted $p/.codex-bridge/"
      COUNT=$((COUNT + 1))
    else
      info "$p has no .codex-bridge/ — skipped"
    fi
    # Also unpin the checkpoint refs the bridge stored inside the repo.
    if git -C "$p" rev-parse --git-dir >/dev/null 2>&1; then
      git -C "$p" for-each-ref --format='%(refname)' refs/bridge-checkpoints 2>/dev/null | \
        while IFS= read -r ref; do
          [ -n "$ref" ] && git -C "$p" update-ref -d "$ref" 2>/dev/null || true
        done
      CHECKPOINT_META=$(git -C "$p" rev-parse --git-path cheap-labor 2>/dev/null || true)
      if [ -n "$CHECKPOINT_META" ]; then
        case "$CHECKPOINT_META" in
          /*) rm -rf "$CHECKPOINT_META" ;;
          *) rm -rf "$p/$CHECKPOINT_META" ;;
        esac
      fi
    fi
  done < <(node -e "
    try {
      const p = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
      if (Array.isArray(p)) p.forEach(x => console.log(x));
    } catch {}
  " "$ledger")
  rm -f "$ledger"
  pass "Ledger removed ($ledger)"
  if [ "$COUNT" -eq 0 ]; then
    info "No projects in this ledger had .codex-bridge/ folders."
  fi
}

printf "\n${CYAN}cheap-labor — uninstaller${RESET}\n"

# ─── Step 1: Legacy MCP registration ─────────────────────────────────────── #
step "1/5 · Legacy MCP registration"
info "Removing [$SERVER_TABLE] from $CODEX_CONFIG"

if [ -f "$CODEX_CONFIG" ]; then
  if grep -q "^\[$SERVER_TABLE\]" "$CODEX_CONFIG"; then
    cp "$CODEX_CONFIG" "$CODEX_CONFIG.bak"
    pass "Backup written to $CODEX_CONFIG.bak"

    # Remove our section (from its table header to the next table header) plus
    # the comment line the installer added, and collapse trailing blank lines.
    # Note: string matching only — BSD awk expands \-escapes in -v values,
    # which would corrupt a regex.
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
      warn "Section still present — something went wrong. Restore with:"
      warn "  mv \"$CODEX_CONFIG.bak\" \"$CODEX_CONFIG\""
    else
      pass "Removed [$SERVER_TABLE] from the shared Codex config."
    fi
  else
    info "Not registered (no [$SERVER_TABLE] found) — nothing to remove."
  fi
else
  info "No config file at $CODEX_CONFIG — nothing to remove."
fi

# ─── Step 2: Stop the tunnel daemon ──────────────────────────────────────── #
step "2/5 · Stop the tunnel daemon"

# Kill the daemon by its own PID first (cheap-labor.pid, written by tunnel.sh),
# then fall back to a profile-scoped pattern so sibling tunnel profiles are
# never touched. The bare "tunnel-client run " pattern would match any profile.
TUNNEL_PIDFILE="$TUNNEL_PROFILE_DIR/cheap-labor.pid"
TUNNEL_RUN_PATTERN="tunnel-client run .*cheap-labor"
STOPPED=false
if [ -f "$TUNNEL_PIDFILE" ]; then
  pid=$(cat "$TUNNEL_PIDFILE" 2>/dev/null || true)
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    for _ in 1 2 3 4 5; do
      kill -0 "$pid" 2>/dev/null || break
      sleep 1
    done
    kill -9 "$pid" 2>/dev/null || true
    STOPPED=true
  fi
  rm -f "$TUNNEL_PIDFILE"
fi
if ! $STOPPED && pgrep -f "$TUNNEL_RUN_PATTERN" >/dev/null 2>&1; then
  pkill -f "$TUNNEL_RUN_PATTERN" 2>/dev/null || true
  sleep 1
  STOPPED=true
fi
if $STOPPED; then
  pass "Stopped the tunnel-client daemon"
else
  pass "No tunnel-client daemon running"
fi
note "For 'tunnel-client runtimes connect' daemons: tunnel-client runtimes stop cheap-labor"

# ─── Step 3: Project state (.codex-bridge/) ──────────────────────────────── #
step "3/5 · Project state (.codex-bridge/)"

if ask_yes "Remove the .codex-bridge/ state (plans, checkpoints, task lists) from every initialized project? (recommended)"; then
  if ! command -v node &>/dev/null; then
    warn "node is not available — cannot read the ledgers. Leaving them and the"
    warn "project .codex-bridge/ folders in place. Re-run with node installed."
  else
    FOUND=false
    for ledger in "$LEDGER" "$LEGACY_LEDGER"; do
      if [ -f "$ledger" ]; then
        FOUND=true
        purge_ledger "$ledger"
      fi
    done
    if [ "$FOUND" = false ]; then
      note "No ledger found — no initialized projects to purge."
    fi
  fi
else
  note "Keeping every .codex-bridge/ folder in place."
  note "(delete a project's .codex-bridge/ manually anytime with: rm -rf <project>/.codex-bridge)"
fi

# ─── Step 4: Tunnel profile ──────────────────────────────────────────────── #
step "4/5 · Tunnel profile + API key"

if ask_yes "Remove the tunnel profile ($TUNNEL_PROFILE) and its stored API key? (recommended)"; then
  if [ -f "$TUNNEL_PROFILE" ] || [ -f "$TUNNEL_PROFILE_DIR/cheap-labor.key" ]; then
    rm -f "$TUNNEL_PROFILE" "$TUNNEL_PROFILE_DIR/cheap-labor.key" \
          "$TUNNEL_PROFILE_DIR/cheap-labor.pid" "$TUNNEL_PROFILE_DIR/cheap-labor.log"
    pass "Removed $TUNNEL_PROFILE, key, and daemon pid/log"
    rmdir "$TUNNEL_PROFILE_DIR" 2>/dev/null || true
  else
    note "No profile at $TUNNEL_PROFILE — nothing to remove."
  fi
else
  note "Keeping the tunnel profile."
fi

# ─── Step 5: Build artifacts (node_modules/, dist/) ──────────────────────── #
step "5/5 · Build artifacts"

if ask_yes "Remove the built artifacts (node_modules/ and dist/)? (recommended)"; then
  rm -rf "$PROJECT_DIR/node_modules" "$PROJECT_DIR/dist"
  pass "Deleted node_modules/ and dist/."
  note "They are regenerable — run ./scripts/install.sh to recreate everything."
else
  note "Keeping node_modules/ and dist/ — reinstall anytime with ./scripts/install.sh"
  note "(or ./scripts/install.sh --skip-build for an instant rebuild)."
fi

# ─── Summary + manual cleanup guide ──────────────────────────────────────── #
hr
printf "${GREEN}Uninstall complete.${RESET}\n\n"

printf "${BOLD}Manual cleanup — browser (parts only you can reach)${RESET}\n"
printf "  1. ▶ App connection: chatgpt.com/plugins → your cheap-labor app → delete it.\n"
printf "  2. ▶ Platform tunnel (optional): platform.openai.com/settings/\n"
printf "     organization/tunnels → delete the tunnel. Keep it if you plan to\n"
printf "     reinstall.\n"
printf "  3. ▶ Runtime API key (recommended): platform.openai.com/settings/\n"
printf "     organization/api-keys → revoke the key you gave the installer.\n\n"

printf "${BOLD}Manual cleanup — local files${RESET}\n"
printf "  • Config backup: %s.bak (delete when satisfied)\n" "$CODEX_CONFIG"
printf "  • Project folder: %s (delete if you don't want the code)\n" "$PROJECT_DIR"
printf "  • Reinstall anytime: cd %s && ./scripts/install.sh\n\n" "$PROJECT_DIR"
