import { execFile } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

import { requireGitTopLevel } from "../git.js";
import {
  projectSessionInputSchema,
  redactSecrets,
  resolveInsideRoot,
  resolveProjectDir,
  sliceLines,
  truncateText,
} from "../safety.js";
import { SKIPPED_DIRS } from "../skips.js";

const execFileAsync = promisify(execFile);

const DEFAULT_MAX_CHARS = 20_000;
const DEFAULT_MAX_LINES = 2_000;
const GIT_TIMEOUT_MS = 30_000;
/** Files larger than this are skipped by grep (read_file has its own caps). */
const MAX_GREP_FILE_BYTES = 2 * 1024 * 1024;

// ---------------------------------------------------------------------------
// list_tree
// ---------------------------------------------------------------------------

export const listTreeInputSchema = projectSessionInputSchema.extend({
  path: z.string().optional().describe("Directory to list, relative to a project root (default: the root itself)."),
  depth: z.number().int().min(0).max(6).optional().describe("Max directory depth to descend (default 2)."),
  include_hidden: z.boolean().optional().describe("Include dotfiles (default false)."),
  max_entries: z.number().int().min(1).optional().describe("Max entries before truncating (default 500)."),
});
export type ListTreeArgs = z.infer<typeof listTreeInputSchema>;

export function listTree(args: ListTreeArgs): string {
  const cwd = resolveProjectDir(args.project, args.session_token);
  const { abs: dir, root } = resolveInsideRoot(args.path ?? ".", cwd);
  const depth = Math.max(0, Math.min(args.depth ?? 2, 6));
  const maxEntries = args.max_entries ?? 500;

  const lines: string[] = [];
  let count = 0;
  let truncated = false;

  const walk = (dirPath: string, curDepth: number, prefix: string): void => {
    if (truncated) return;
    if (count >= maxEntries) {
      truncated = true;
      return;
    }

    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dirPath, { withFileTypes: true }).sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    } catch {
      return;
    }

    for (let i = 0; i < entries.length; i++) {
      if (truncated) return;
      const name = entries[i].name;
      if (!args.include_hidden && name.startsWith(".")) continue;
      if (SKIPPED_DIRS.has(name)) continue;

      const isDir = entries[i].isDirectory();

      const last = i === entries.length - 1;
      lines.push(prefix + (last ? "└── " : "├── ") + name + (isDir ? "/" : ""));
      count++;

      if (isDir && curDepth < depth) {
        walk(path.join(dirPath, name), curDepth + 1, prefix + (last ? "    " : "│   "));
      }
    }
  };

  // Read the root dir itself (don't filter hidden for the anchor line).
  let anchorName = path.relative(root, dir) || path.basename(dir) || root;
  lines.push(anchorName + "/");
  walk(dir, 1, "");

  if (truncated) {
    lines.push(`… [truncated at ${maxEntries} entries — raise max_entries to see more]`);
  }
  lines.push(`(${count} entries, depth ${depth})`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// read_file
// ---------------------------------------------------------------------------

export const readFileInputSchema = projectSessionInputSchema.extend({
  path: z.string().describe("File path relative to a project root, or absolute inside a root."),
  offset: z.number().int().positive().optional().describe("1-indexed first line to return (default 1)."),
  limit: z.number().int().min(1).max(10_000).optional().describe("Max lines to return (default 2000)."),
  max_chars: z.number().int().positive().optional().describe("Hard cap on returned characters (default 20000)."),
  redact_secrets: z.boolean().optional().describe("Redact known secret patterns (default true)."),
});
export type ReadFileArgs = z.infer<typeof readFileInputSchema>;

export function readFile(args: ReadFileArgs): string {
  const cwd = resolveProjectDir(args.project, args.session_token);
  const { abs, root } = resolveInsideRoot(args.path, cwd);
  const rel = path.relative(root, abs);

  const stat = statSync(abs);
  if (stat.isDirectory()) {
    throw new Error(`"${args.path}" is a directory — use list_tree to browse it.`);
  }

  const maxChars = args.max_chars ?? DEFAULT_MAX_CHARS;
  const maxLines = Math.min(args.limit ?? DEFAULT_MAX_LINES, 10_000);

  const buf = readFileSync(abs);
  if (buf.includes(0)) {
    throw new Error(`"${rel}" appears to be a binary file (NUL bytes) — refusing to dump it.`);
  }
  const text = buf.toString("utf8");
  const totalLines = text.split("\n").length;

  const sliced = sliceLines(text, args.offset, args.offset ? args.offset + maxLines - 1 : maxLines);
  const redacted = (args.redact_secrets ?? true) ? redactSecrets(sliced) : sliced;
  const shown = truncateText(redacted, maxChars);
  const note = shown.length < sliced.length ? " (truncated)" : "";
  const shownLines = shown.split("\n").length;
  const startLine = args.offset ?? 1;
  const endLine = Math.min(startLine + shownLines - 1, totalLines);

  return [
    `file: ${rel}${note}`,
    `lines ${startLine}-${endLine} of ${totalLines}`,
    "```",
    shown,
    "```",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// grep
// ---------------------------------------------------------------------------

export const grepInputSchema = projectSessionInputSchema.extend({
  pattern: z.string().describe("Regular expression to search for."),
  path: z.string().optional().describe("Directory to search, relative to a project root (default: the root itself)."),
  include: z.array(z.string()).optional().describe("Glob patterns for files to include, e.g. [\"*.ts\"] (default: all)."),
  exclude: z.array(z.string()).optional().describe("Glob patterns for paths to exclude."),
  max_results: z.number().int().min(1).optional().describe("Max matches to return (default 30)."),
  redact_secrets: z.boolean().optional().describe("Redact known secret patterns from the output (default true)."),
});
export type GrepArgs = z.infer<typeof grepInputSchema>;

/**
 * Convert a simple glob (supports *, **, ?) into a RegExp.
 * "**" matches across directory boundaries; "**" + "/" (globstar followed
 * by a slash) matches zero or more directory segments.
 */
function globToRegExp(glob: string): RegExp {
  // Placeholders shield the segments we insert from the later "*" pass.
  let out = glob
    .replace(/\*\*\//g, "\u0001") // "**/" → zero or more directory segments
    .replace(/\*\*/g, "\u0002") // bare "**" → anything, including "/"
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\u0002/g, ".*")
    .replace(/\u0001/g, "(?:[^/]*/)*");
  return new RegExp(`^${out}$`);
}

export function grep(args: GrepArgs): string {
  let re: RegExp;
  try {
    re = new RegExp(args.pattern);
  } catch (e) {
    throw new Error(`Invalid pattern: ${(e as Error).message}`);
  }

  const { abs: dir, root } = resolveInsideRoot(args.path ?? ".", resolveProjectDir(args.project, args.session_token));
  const maxResults = args.max_results ?? 30;
  const includes = (args.include ?? []).map(globToRegExp);
  const excludes = (args.exclude ?? []).map(globToRegExp);

  const matches: string[] = [];
  let filesScanned = 0;
  let filesSkippedLarge = 0;

  const walk = (dirPath: string): void => {
    if (matches.length >= maxResults) return;
    let entries: string[];
    try {
      entries = readdirSync(dirPath);
    } catch {
      return;
    }
    for (const name of entries) {
      if (matches.length >= maxResults) return;
      if (name.startsWith(".") || SKIPPED_DIRS.has(name)) continue;
      const full = path.join(dirPath, name);
      const rel = path.relative(dir, full).split(path.sep).join("/");
      if (excludes.some((r) => r.test(rel))) continue;

      let isDir: boolean;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        walk(full);
        continue;
      }
      // Match against the relative path OR the basename: "*.ts" still hits
      // nested files, while "src/**/*.ts" can target a subtree.
      if (includes.length > 0 && !includes.some((r) => r.test(rel) || r.test(path.basename(full)))) continue;

      filesScanned++;
      let text: string;
      try {
        if (statSync(full).size > MAX_GREP_FILE_BYTES) {
          filesSkippedLarge++;
          continue;
        }
        const buf = readFileSync(full);
        if (buf.includes(0)) continue; // skip binaries
        text = buf.toString("utf8");
      } catch {
        continue;
      }
      for (const [i, line] of text.split("\n").entries()) {
        if (matches.length >= maxResults) return;
        if (re.test(line)) {
          matches.push(`${rel}:${i + 1}:${line.slice(0, 300)}`);
        }
      }
    }
  };

  walk(dir);

  if (matches.length === 0) {
    const skipNote = filesSkippedLarge > 0 ? ` (${filesSkippedLarge} large file(s) skipped)` : "";
    return `No matches for /${args.pattern}/ in ${path.relative(root, dir) || "."} (${filesScanned} files scanned${skipNote}).`;
  }
  const truncatedNote = matches.length >= maxResults ? `\n… [capped at ${maxResults} matches]` : "";
  const skipNote = filesSkippedLarge > 0 ? `\n(${filesSkippedLarge} large file(s) skipped)` : "";
  const body = (args.redact_secrets ?? true) ? redactSecrets(matches.join("\n")) : matches.join("\n");
  return `${matches.length} match(es) for /${args.pattern}/ (${filesScanned} files scanned${skipNote}):\n` + body + truncatedNote;
}

// ---------------------------------------------------------------------------
// git_* helpers
// ---------------------------------------------------------------------------

async function git(root: string, gitArgs: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", gitArgs, {
      cwd: root,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 20 * 1024 * 1024,
    });
    return stdout;
  } catch (e) {
    const err = e as { stderr?: string; message?: string };
    const msg = err.stderr?.trim() || err.message || String(e);
    if (/not a git repository/i.test(msg)) {
      throw new Error(`"${root}" is not inside a git repository.`);
    }
    throw new Error(`git ${gitArgs[0]} failed: ${msg}`);
  }
}

export const gitStatusInputSchema = projectSessionInputSchema.extend({
  path: z.string().optional().describe("Restrict to a path inside the root (default: whole repo)."),
});
export type GitStatusArgs = z.infer<typeof gitStatusInputSchema>;

export async function gitStatus(args: GitStatusArgs): Promise<string> {
  const root = resolveProjectDir(args.project, args.session_token);
  requireGitTopLevel(root);
  const gitArgs = ["--no-pager", "status"];
  if (args.path && args.path !== ".") {
    const { abs } = resolveInsideRoot(args.path, root);
    gitArgs.push("--", path.relative(root, abs));
  }
  const out = await git(root, gitArgs);
  return out.trim() === "" ? "clean working tree" : out.trim();
}

export const gitDiffInputSchema = projectSessionInputSchema.extend({
  cached: z.boolean().optional().describe("Diff staged (cached) changes instead of unstaged."),
  path: z.string().optional().describe("Restrict the diff to a path inside the root."),
  context: z.number().int().min(0).optional().describe("Unified context lines (default 3)."),
  redact_secrets: z.boolean().optional().describe("Redact known secret patterns (default true)."),
});
export type GitDiffArgs = z.infer<typeof gitDiffInputSchema>;

export async function gitDiff(args: GitDiffArgs): Promise<string> {
  const root = resolveProjectDir(args.project, args.session_token);
  requireGitTopLevel(root);
  const gitArgs = ["--no-pager", "-c", "core.pager=cat", "diff"];
  if (args.cached) gitArgs.push("--cached");
  gitArgs.push(`-U${args.context ?? 3}`);
  if (args.path && args.path !== ".") {
    const { abs } = resolveInsideRoot(args.path, root);
    gitArgs.push("--", path.relative(root, abs));
  }
  const out = await git(root, gitArgs);
  const redacted = (args.redact_secrets ?? true) ? redactSecrets(out) : out;
  const parts: string[] = [];
  if (redacted.trim() !== "") {
    parts.push(truncateText(redacted, DEFAULT_MAX_CHARS));
  }
  // Plain `git diff` omits untracked files — surface them for the review loop.
  if (!args.cached && !args.path) {
    const untracked = await untrackedFiles(root);
    if (untracked.length > 0) {
      const lines = [`untracked files (not in the diff — read_file them to review):`];
      for (const rel of untracked) {
        lines.push(`  ${rel}`);
      }
      parts.push(lines.join("\n"));
    }
  }
  if (parts.length === 0) {
    return args.cached ? "no staged changes" : "no unstaged changes";
  }
  return parts.join("\n\n");
}

/** List untracked (??) file paths via `git status --porcelain`, relative to root. */
async function untrackedFiles(root: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("git", ["status", "--porcelain", "--untracked-files=all"], {
      cwd: root,
      timeout: GIT_TIMEOUT_MS,
    });
    return stdout
      .split("\n")
      .filter((l) => l.startsWith("?? "))
      .map((l) => l.slice(3).trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

export const gitLogInputSchema = projectSessionInputSchema.extend({
  count: z.number().int().min(1).max(200).optional().describe("Number of commits (default 20)."),
  path: z.string().optional().describe("Restrict log to a path inside the root."),
});
export type GitLogArgs = z.infer<typeof gitLogInputSchema>;

export async function gitLog(args: GitLogArgs): Promise<string> {
  const root = resolveProjectDir(args.project, args.session_token);
  requireGitTopLevel(root);
  const count = Math.max(1, Math.min(args.count ?? 20, 200));
  const gitArgs = ["--no-pager", "log", `-n${count}`, "--oneline", "--decorate"];
  if (args.path && args.path !== ".") {
    const { abs } = resolveInsideRoot(args.path, root);
    gitArgs.push("--", path.relative(root, abs));
  }
  const out = await git(root, gitArgs);
  return out.trim() === "" ? "no commits yet" : out.trim();
}
