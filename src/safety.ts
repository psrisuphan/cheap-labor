import { realpathSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

import { getApprovedProject } from "./projects.js";

export const projectSessionInputSchema = z.object({
  project: z
    .string()
    .optional()
    .describe("Project path named in chat (armed via init). Pass it on every call."),
  session_token: z
    .string()
    .optional()
    .describe("Session token from init/create_project for this chat. Pass it on every call."),
});

export type ProjectSessionArgs = z.infer<typeof projectSessionInputSchema>;

/**
 * Safety helpers: path scoping to the session-approved project directory, and
 * text truncation so the bridge never dumps unbounded data into the chat.
 *
 * Access model: there are no pre-approved roots. Every project the user names
 * must be armed in chat (explicit invocation → init → session_token) before any
 * tool may touch it. The approved project directory is the containment
 * boundary.
 */

/**
 * Resolve the project directory a tool call should work in.
 *
 * The user names the project once per chat, ChatGPT arms the session with
 * init, and passes the returned session_token (plus the project path) on
 * every tool call. Approvals are per-chat: a new chat has no token and must
 * arm again. The bridge stores no "current project" state — a stdio server
 * is shared across chats.
 *
 * Throws descriptive errors so ChatGPT always knows what to ask the user.
 */
export function resolveProjectDir(project?: string, sessionToken?: string): string {
  if (project === undefined || project.trim() === "") {
    throw new Error(
      `No project named and the session is not armed. cheap-labor is dormant: it is activated only by an ` +
        `@cheap-labor mention — otherwise answer the user without any bridge tools.`,
    );
  }

  const abs = path.resolve(project);
  const real = canonicalizeBestEffort(abs);

  if (sessionToken) {
    const approved = getApprovedProject(sessionToken);
    if (approved && (real === approved || isWithin(approved, real))) {
      return real;
    }
    throw new Error(
      `The session_token does not match project "${project}" (tokens are per-chat and per-project). ` +
        `Tell the user to mention @cheap-labor to re-arm this chat.`,
    );
  }

  throw new Error(
    `Project "${project}" requires in-session approval — the session is not armed. cheap-labor is ` +
      `dormant: it is activated only by an @cheap-labor mention.`,
  );
}

/**
 * Resolve a user-supplied path (relative to the approved project `cwd` or
 * absolute) and verify it lives inside that project directory. Returns the
 * resolved absolute path and the project dir. Throws if outside.
 */
export function resolveInsideRoot(
  input: string,
  cwd: string,
): { abs: string; root: string } {
  const abs = path.resolve(cwd, input);
  const resolved = canonicalizeBestEffort(abs);

  if (!isWithin(cwd, resolved)) {
    throw new Error(
      `Path "${input}" resolves to "${resolved}" which is outside the approved project ` +
        `"${cwd}". Refusing.`,
    );
  }
  return { abs: resolved, root: cwd };
}

/** True when `candidate` is `parent` itself or nested inside it. */
export function isWithin(parent: string, candidate: string): boolean {
  const rel = path.relative(parent, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Best-effort realpath; returns undefined when the path doesn't exist. */
function safeRealpath(p: string): string | undefined {
  try {
    return realpathSync(p);
  } catch {
    return undefined;
  }
}

/**
 * Canonicalize a path even when it (partly) doesn't exist yet: resolves the
 * deepest existing ancestor and re-joins the remainder. Handles macOS
 * /var → /private/var style symlinks for not-yet-created paths.
 */
function canonicalizeBestEffort(p: string): string {
  const real = safeRealpath(p);
  if (real) return real;
  const parent = path.dirname(p);
  if (parent === p) return p;
  return path.join(canonicalizeBestEffort(parent), path.basename(p));
}

// ---------------------------------------------------------------------------
// Secret redaction
// ---------------------------------------------------------------------------

const SECRET_PATTERNS: RegExp[] = [
  // OpenAI / Anthropic / Gemini-style API keys
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  // GitHub / GitLab personal access tokens
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bglpat-[A-Za-z0-9_-]{16,}/g,
  // AWS access key ids + secret access keys
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b(?:aws)?_?secret_access_key\s*[=:]\s*['"]?[A-Za-z0-9/+=]{20,}/gi,
  // Slack tokens
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
  // JWT / bearer tokens
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /(?:authorization|bearer)\s*:\s*(?:basic|bearer)\s+[A-Za-z0-9._~+/-]+/gi,
  // Private key blocks
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY BLOCK?-----([\s\S]*?)-----END (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY BLOCK?-----/g,
  // All-caps env-style assignments (line start): NAME=value
  /^\s*(?:[A-Z][A-Z0-9_]*?(?:API_KEY|SECRET|PASSWORD|TOKEN|PASSWD|PRIVATE_KEY|ACCESS_KEY|AUTH|CREDENTIALS?|SECRET_KEY))\s*=\s*\S+.*$/gm,
];

const REDACTED = "[REDACTED]";

/** Replace known secret patterns with [REDACTED]. Line count is preserved. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (match) => {
      // Keep short keys intact to avoid mangling benign identifiers.
      if (match.length < 12) return match;
      return REDACTED;
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Command risk classification (used by the approval policy and run_command)
// ---------------------------------------------------------------------------

export type CommandRisk = "read-only" | "write" | "network" | "risky";

/** Strip common shell wrappers (sh -lc '...', zsh -lc "...", bash -c ...). */
function unwrapShellWrapper(cmd: string): string {
  let c = cmd.trim();
  // /bin/zsh -lc '...' or sh -c "..." — peel the leading interpreter + flags.
  const wrapper = /^(?:\/\S+\/)?(?:sh|bash|zsh|dash|fish)\s+(-[a-zA-Z]+\s+)*['"]/;
  if (wrapper.test(c)) {
    const firstQuote = c.indexOf("'") >= 0 && (c.indexOf('"') < 0 || c.indexOf("'") < c.indexOf('"'))
      ? c.indexOf("'")
      : c.indexOf('"');
    if (firstQuote >= 0) {
      const quote = c[firstQuote];
      const close = c.lastIndexOf(quote);
      if (close > firstQuote) {
        c = c.slice(firstQuote + 1, close);
      }
    }
  }
  return c.trim();
}

const DANGEROUS_COMMANDS =
  /\b(rm|rmdir|mv|cp|mkdir|touch|ln|chmod|chown|chgrp|truncate|dd|tee|shred|unlink|install|mkfs|fdisk|kill|pkill|killall)\b/;
const NETWORK_COMMANDS =
  /\b(curl|wget|ssh|scp|sftp|rsync|nc|netcat|telnet|ftp|git\s+(clone|fetch|pull|push|remote)|npm\s+(install|add|publish|init|update|uninstall|remove)|pnpm\s+(install|add|publish|update|remove)|yarn\s+(add|install|publish|remove)|bun\s+(add|install|remove)|pip\s+(install|download|uninstall)|pip3\s+(install|download|uninstall)|cargo\s+(install|add|publish)|brew\s+(install|uninstall|update|upgrade)|apt(-get)?\s+(install|remove|update|upgrade)|dnf|yum|pacman)\b/;
const GIT_MUTATIONS =
  /\bgit\s+(add|commit|push|reset|rebase|merge|cherry-pick|revert|checkout|restore|clean|stash|tag|branch\s+-[dD]|remote\s+(add|remove|set-url|rename))\b/;
const REDIRECT_WRITE = /(^|[^0-9&|])(>|>>)\s*[^&]|\|\s*tee\b/;
/**
 * Interpreter one-liners execute arbitrary code — the payload can assemble
 * dangerous operations at runtime, so keyword matching can never see them.
 * They are always treated as risky (never auto-run). Shells are included
 * because `bash -c "…"` is exactly as powerful as `python -c "…"`. Combined
 * short flags (`-lc`, `-le`) are covered by the `[a-zA-Z]*` prefix.
 */
const INTERPRETER_ONELINERS =
  /\b(?:python3?|node|perl|ruby|php|deno|bun|bash|zsh|dash|fish|sh)\s+-{1,2}(?:[a-zA-Z]*c\b|[a-zA-Z]*e\b|[a-zA-Z]*eval\b)/;

/**
 * Classify a shell command as safe (read-only) or risky. Conservative: only
 * commands with no write/network/mutation tokens are "read-only".
 */
export function classifyCommand(raw: string): CommandRisk {
  // Check the raw command first: `bash -c 'ls'` must stay risky regardless of
  // quoting — the wrapper is the danger, not the visible payload.
  if (INTERPRETER_ONELINERS.test(raw)) return "risky";
  const cmd = unwrapShellWrapper(raw);
  if (INTERPRETER_ONELINERS.test(cmd)) return "risky";
  if (NETWORK_COMMANDS.test(cmd)) return "network";
  if (GIT_MUTATIONS.test(cmd)) return "write";
  if (REDIRECT_WRITE.test(cmd)) return "write";
  if (DANGEROUS_COMMANDS.test(cmd)) return "write";
  return "read-only";
}

// ---------------------------------------------------------------------------
// Command buckets (used by run_command and the Codex approval policy)
// ---------------------------------------------------------------------------

/**
 * Three buckets decide how a command is treated:
 *   - "safe":   provably read-only (executable on the allowlist, no dangerous
 *               tokens). Runs silently in BOTH modes.
 *   - "ask":    dangerous by construction (file deletes, git rewrites, network,
 *               interpreter one-liners). ALWAYS requires the user — the bridge
 *               never lets the model's judgment skip this bucket.
 *   - "judged": everything else (e.g. `node script.js`, `npm test`, custom
 *               binaries). Normal mode → ask the user; auto mode → the model
 *               may judge it safe and run it.
 */
export type CommandBucket = "safe" | "judged" | "ask";

/** Executables whose plain invocations are read-only and side-effect free. */
const SAFE_EXECUTABLES = new Set([
  "git", "ls", "cat", "pwd", "echo", "wc", "head", "tail", "grep", "rg",
  "sort", "uniq", "printf", "date",
]);
/** `git` subcommands that never mutate state. */
const SAFE_GIT_SUBCOMMANDS = new Set([
  "status", "log", "diff", "show", "rev-parse", "ls-files", "ls-tree",
  "for-each-ref", "config", "remote",
]);

/** Split a command line into executable + args, respecting single/double quotes. */
export function splitCommandLine(line: string): { command: string; args: string[] } {
  const parts: string[] = [];
  let cur = "";
  let inSingle = false;
  let inDouble = false;
  for (const ch of line) {
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (/\s/.test(ch) && !inSingle && !inDouble) {
      if (cur) {
        parts.push(cur);
        cur = "";
      }
      continue;
    }
    cur += ch;
  }
  if (cur) parts.push(cur);
  return { command: parts[0] ?? "", args: parts.slice(1) };
}

/**
 * Is this executable+args a provably read-only invocation? The allowlist is
 * small on purpose — anything not listed falls into the "judged" bucket.
 */
export function isSafeAllowlisted(command: string, args: string[]): boolean {
  if (!SAFE_EXECUTABLES.has(command)) return false;
  if (command === "git") {
    const sub = args[0];
    if (!sub || !SAFE_GIT_SUBCOMMANDS.has(sub)) return false;
    // `git config` can write to user/global scope — only `--get`-style reads.
    if (sub === "config") {
      return args.some((a) => a === "--get" || a === "--get-all" || a === "--list" || a === "-l");
    }
    // `git remote` mutates only with add/remove/set-url/rename — blocked by
    // classifyCommand (GIT_MUTATIONS), which runs before this check in
    // bucketCommand. Bare `git remote` just lists.
    return true;
  }
  return true;
}

/** Classify a command into a bucket using the risk classifier + allowlist. */
export function bucketCommand(command: string, args: string[]): CommandBucket {
  const full = [command, ...args].join(" ");
  const risk = classifyCommand(full);
  if (risk === "read-only" && isSafeAllowlisted(command, args)) return "safe";
  if (risk !== "read-only") return "ask";
  return "judged";
}

/** Truncate a string to `maxChars`, appending a note when cut. */
export function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const head = Math.floor(maxChars * 0.8);
  const tail = maxChars - head;
  return (
    text.slice(0, head) +
    `\n… [truncated: ${text.length - head - tail} chars omitted] …\n` +
    text.slice(text.length - tail)
  );
}

/** Extract the line range [start, end] (1-indexed inclusive) from text. */
export function sliceLines(text: string, start?: number, end?: number): string {
  const lines = text.split("\n");
  const s = start && start > 0 ? start - 1 : 0;
  const e = end && end >= s ? Math.min(end, lines.length) : lines.length;
  return lines.slice(s, e).join("\n");
}
