#!/usr/bin/env node
/**
 * One-command setup helper: checks prerequisites and prints the setup path.
 * The main (and only) route is ChatGPT Chat on the web via Secure MCP Tunnel.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const entry = path.join(projectRoot, "dist", "index.js");

console.log("cheap-labor — setup\n");

// 1. Prerequisites
let codexOk = false;
try {
  execFileSync("codex", ["--version"], { stdio: "ignore" });
  codexOk = true;
} catch {
  /* not installed */
}
console.log(`[1/3] Codex CLI installed:      ${codexOk ? "yes" : "NO — install from https://github.com/openai/codex"}`);

// `codex login status` prints its result to stderr (with exit code 0).
const login = spawnSync("codex", ["login", "status"], { encoding: "utf8" });
const loggedIn = /logged in/i.test(`${login.stdout} ${login.stderr}`);
console.log(`      Codex logged in:          ${loggedIn ? "yes" : "NO — run: codex login"}`);

console.log(`[2/3] Bridge built:             ${existsSync(entry) ? "yes" : "NO — run: npm run build"}`);

// 3. Setup path
console.log("[3/3] Run the guided installer (builds + walks you through the tunnel):\n");
console.log("  ./scripts/install.sh\n");
console.log(`  (the bridge entry is: ${entry})\n`);
console.log(`  The installer: installs deps, builds, removes any legacy desktop-app
  registration, asks for your tunnel id + runtime API key (with links to
  where to get each), writes the tunnel-client profile, and validates the
  bridge. Then:

    1. ./scripts/tunnel.sh start            # keep this daemon running
    2. https://chatgpt.com/plugins → plus → Connection: Tunnel → select tunnel
    3. New Chat on chatgpt.com → tools menu → add the connection
    4. Mention it: @cheap-labor

  While dormant the bridge costs the model nothing (instructions say 'ignore
  these tools'); the workflow rules arrive with the init tool result.\n`);

if (!codexOk || !loggedIn || !existsSync(entry)) {
  process.exitCode = 1;
}
