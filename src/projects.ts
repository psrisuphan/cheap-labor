import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { SKIPPED_DIRS } from "./skips.js";

/**
 * Session-scoped project approvals. Every project the user names requires
 * in-chat approval: the user @-mentions cheap-labor, ChatGPT calls `init`,
 * and passes the returned session_token on every tool call.
 *
 * Approvals live only in memory (and only for this bridge process). A new
 * ChatGPT chat has no token, so the bridge forces it to arm again — exactly
 * "approved for this session" semantics without any global state.
 */

const approvals = new Map<string, string>(); // token -> canonical project path

// ---------------------------------------------------------------------------
// Approved-project ledger (local; the uninstaller reads it to purge the
// .codex-bridge/ state of every initialized project)
// ---------------------------------------------------------------------------

const MAX_LEDGER_ENTRIES = 200;

/** Where the ledger lives. Overridable for tests via BRIDGE_LEDGER_FILE. */
export function ledgerPath(): string {
  if (process.env.BRIDGE_LEDGER_FILE) return process.env.BRIDGE_LEDGER_FILE;
  const home = process.env.CODEX_HOME ?? path.join(homedir(), ".codex");
  return path.join(home, "cheap-labor-approved-projects.json");
}

/** Record an approved project path in the ledger. Never throws. */
export function recordProject(project: string): void {
  try {
    const file = ledgerPath();
    let existing: string[] = [];
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
      if (Array.isArray(parsed)) existing = parsed as string[];
    } catch {
      existing = [];
    }
    const deduped = [project, ...existing.filter((p) => p !== project)].slice(0, MAX_LEDGER_ENTRIES);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(deduped, null, 2), "utf8");
  } catch {
    // Ledger is best-effort; approval must never fail because of it.
  }
}

interface ArmResult {
  /** Canonical project path the token was issued for. */
  project: string;
  session_token: string;
}

/**
 * Verify a project path exists and is a directory, returning the canonical
 * path. Throws descriptive errors so ChatGPT always knows what to ask.
 */
function resolveApprovalPath(project: string): string {
  const abs = path.resolve(project);
  let real: string;
  try {
    real = realpathSync(abs);
  } catch {
    throw new Error(
      `"${project}" does not exist. If this is a new project, ask the user where to create it ` +
        `and call create_project instead. Otherwise ask for the correct path.`,
    );
  }
  if (!statSync(real).isDirectory()) {
    throw new Error(`"${project}" is not a directory.`);
  }
  return real;
}

/**
 * Arm the cheap-labor session for a project: the single entry point that
 * approves an existing project and returns its canonical path plus a fresh
 * per-chat session token. Calling init again for another project simply
 * issues an additional token — multiple projects can be armed in one chat.
 */
export function initProject(project: string): ArmResult {
  const real = resolveApprovalPath(project);
  const token = randomUUID();
  approvals.set(token, real);
  recordProject(real);
  return { project: real, session_token: token };
}

/** The canonical project path a token was issued for, or undefined. */
export function getApprovedProject(token: string): string | undefined {
  return approvals.get(token);
}

// ---------------------------------------------------------------------------
// Fuzzy project lookup (find_projects)
// ---------------------------------------------------------------------------

/**
 * Well-known, shallow locations where projects usually live. find_projects
 * only scans these (max 2 levels, no hidden dirs) so a fuzzy name like "the
 * app on my Desktop" can be resolved without walking the whole disk.
 */
const DEFAULT_SEARCH_ROOTS: string[] = (() => {
  const home = homedir();
  return [
    home,
    path.join(home, "Desktop"),
    path.join(home, "Documents"),
    path.join(home, "Projects"),
    path.join(home, "Developer"),
    path.join(home, "code"),
    path.join(home, "dev"),
    path.join(home, "src"),
    path.join(home, "workspace"),
  ].filter((p) => {
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  });
})();

interface ProjectCandidate {
  name: string;
  path: string;
}

/**
 * Find directory candidates under the search roots whose name contains
 * `query` (case-insensitive). Max depth 2, hidden dirs and common noise
 * (node_modules, .git) skipped. Capped at MAX_RESULTS. Empty query returns
 * all directories found (top-level project candidates).
 */
export function findProjects(query: string, searchRoots: string[] = DEFAULT_SEARCH_ROOTS): ProjectCandidate[] {
  const needle = query.trim().toLowerCase();
  const results: ProjectCandidate[] = [];
  const MAX_RESULTS = 30;
  const MAX_DEPTH = 2;

  const walk = (dir: string, depth: number): void => {
    if (results.length >= MAX_RESULTS || depth > MAX_DEPTH) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (results.length >= MAX_RESULTS) return;
      if (e.name.startsWith(".")) continue;
      if (!e.isDirectory()) continue;
      if (SKIPPED_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (needle === "" || e.name.toLowerCase().includes(needle)) {
        results.push({ name: e.name, path: full });
      }
      if (depth < MAX_DEPTH) walk(full, depth + 1);
    }
  };

  for (const root of searchRoots) {
    walk(root, 1);
    if (results.length >= MAX_RESULTS) break;
  }

  // Better matches first: name starts with the query, then shorter names.
  results.sort((a, b) => {
    const aStarts = needle !== "" && a.name.toLowerCase().startsWith(needle) ? 0 : 1;
    const bStarts = needle !== "" && b.name.toLowerCase().startsWith(needle) ? 0 : 1;
    if (aStarts !== bStarts) return aStarts - bStarts;
    return a.name.length - b.name.length || a.path.localeCompare(b.path);
  });
  return results.slice(0, MAX_RESULTS);
}

// ---------------------------------------------------------------------------
// New project creation (create_project)
// ---------------------------------------------------------------------------

interface CreateProjectResult {
  created: string;
  session_token: string;
}

/**
 * Create a brand-new project directory. Guards:
 * - The path must NOT exist yet (never touch an existing dir — existing
 *   projects go through init).
 * - The parent directory must exist (no silently created deep trees).
 *
 * Git is intentionally NOT initialized — the project is just a directory.
 * The user decides when (and whether) to `git init` it.
 *
 * Because the user already confirmed the exact target path in chat, creation
 * also approves the project for this session (one confirmation, one token).
 */
export function createProject(project: string): CreateProjectResult {
  const abs = path.resolve(project);
  if (existsSync(abs)) {
    throw new Error(
      `"${project}" already exists — use init to work in it (after the user confirms).`,
    );
  }
  const parent = path.dirname(abs);
  try {
    if (!statSync(parent).isDirectory()) throw new Error();
  } catch {
    throw new Error(
      `Parent directory "${parent}" does not exist — ask the user where to create the project.`,
    );
  }

  mkdirSync(abs);

  const token = randomUUID();
  approvals.set(token, realpathSync(abs));
  recordProject(realpathSync(abs));
  return { created: realpathSync(abs), session_token: token };
}
