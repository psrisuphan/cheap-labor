import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";

/**
 * Global bridge settings, stored once per user (not per project).
 *
 * `approvalMode` controls how commands are approved:
 *   - "normal" (default): every command outside the provably-safe allowlist
 *     must be confirmed by the user in chat first.
 *   - "auto": ChatGPT judges commands itself and may run safe ones, but
 *     dangerous commands (file deletion, git rewrites, network installs,
 *     interpreter one-liners) always ask the user first.
 *
 * The user can change the mode at any time via the `set_approval_mode` tool
 * (triggered by an @cheap-labor mention in chat). Settings are read on every
 * call so a change takes effect immediately.
 */

export const approvalModeSchema = z.enum(["normal", "auto"]);
export type ApprovalMode = z.infer<typeof approvalModeSchema>;

const DEFAULT_MODE: ApprovalMode = "normal";

/** Where the settings file lives. Overridable for tests via BRIDGE_SETTINGS_FILE. */
export function settingsPath(): string {
  if (process.env.BRIDGE_SETTINGS_FILE) return process.env.BRIDGE_SETTINGS_FILE;
  const home = process.env.CODEX_HOME ?? path.join(homedir(), ".codex");
  return path.join(home, "cheap-labor-settings.json");
}

interface SettingsFile {
  approvalMode?: ApprovalMode;
}

function readSettings(): SettingsFile {
  try {
    const parsed = JSON.parse(readFileSync(settingsPath(), "utf8")) as unknown;
    if (parsed && typeof parsed === "object") return parsed as SettingsFile;
  } catch {
    // Missing or corrupt file → defaults.
  }
  return {};
}

/** The current approval mode (default "normal"). */
export function getApprovalMode(): ApprovalMode {
  return readSettings().approvalMode === "auto" ? "auto" : DEFAULT_MODE;
}

/** Persist the approval mode. Returns the stored mode. */
export function setApprovalMode(mode: ApprovalMode): ApprovalMode {
  const file = settingsPath();
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ approvalMode: mode }, null, 2), "utf8");
  try {
    chmodSync(file, 0o600);
  } catch {
    // Best-effort — permissions are not the security boundary here.
  }
  return mode;
}
