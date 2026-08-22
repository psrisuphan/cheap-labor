import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";

import { requireGitTopLevel } from "../git.js";
import { projectSessionInputSchema, resolveInsideRoot, resolveProjectDir } from "../safety.js";

/**
 * M4: ship mode — the safe git loop between "code written" and "code
 * committed". All git plumbing is hardcoded (no arbitrary commands), and
 * there is NEVER any push/pull/reset/rebase/checkout of branches.
 *
 * - `checkpoint` snapshots HEAD + working tree (tracked AND untracked) into a
 *   detached tree object via a temporary index (never touches the user's
 *   index, branches, or stash) and records metadata under Git's private
 *   directory. Taken automatically before `implement`.
 * - `rollback` restores the working tree to a checkpoint (it first takes a
 *   fresh checkpoint of the current state, so rollbacks are themselves
 *   undoable). User-confirmed.
 * - `git_commit` stages named files (or everything) and commits with a
 *   user-approved message. Never touches remotes.
 * - `checkpoints` lists recorded checkpoints.
 */

const CHECKPOINTS_FILE = "cheap-labor/checkpoints.json";
const LEGACY_CHECKPOINTS_FILE = ".codex-bridge/checkpoints.json";
const MAX_CHECKPOINTS = 20;
const CHECKPOINTS_REF_PREFIX = "refs/bridge-checkpoints/";
/** The bridge's working folder is never staged into commits. */
const EXCLUDE_PLAN_DIR = ":(exclude).codex-bridge";
/** Upper bound on any single git invocation (a stuck/locked repo must not hang the bridge). */
const GIT_TIMEOUT_MS = 30_000;

export const checkpointInputSchema = projectSessionInputSchema.extend({
  note: z.string().optional().describe("Optional label for this checkpoint."),
});
export type CheckpointArgs = z.infer<typeof checkpointInputSchema>;

export const rollbackInputSchema = projectSessionInputSchema.extend({
  id: z.string().optional().describe("Checkpoint id to restore (default: latest)."),
});
export type RollbackArgs = z.infer<typeof rollbackInputSchema>;

export const gitCommitInputSchema = projectSessionInputSchema.extend({
  files: z.array(z.string()).optional().describe("Files to stage (default: all changes)."),
  message: z.string().regex(/\S/, "Commit message must not be blank.").describe("Commit message."),
});
export type GitCommitArgs = z.infer<typeof gitCommitInputSchema>;

export const checkpointsInputSchema = projectSessionInputSchema;
export type CheckpointsArgs = z.infer<typeof checkpointsInputSchema>;

export class NoCommitsError extends Error {}

interface CheckpointEntry {
  id: string;
  base: string;
  /**
   * Commit object capturing the full working tree (tracked + untracked).
   * Pinned by `refs/bridge-checkpoints/<id>` so git gc can never prune it.
   */
  commit: string;
  created_at: string;
  note?: string;
}

function git(root: string, args: string[], opts: { allowFailure?: boolean; raw?: boolean } = {}): string {
  try {
    const output = execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 20 * 1024 * 1024,
      env: { ...process.env, LC_ALL: "C" },
    });
    return opts.raw ? output : output.trim();
  } catch (e) {
    if (opts.allowFailure) return "";
    const err = e as { stderr?: string; message?: string };
    const msg = err.stderr?.trim() || err.message || String(e);
    if (/not a git repository/i.test(msg)) {
      throw new Error(
        `The approved project is not inside a git repository. ` +
          `Run "git init" in the project (and make a first commit) to enable git tools.`,
      );
    }
    throw new Error(`git ${args[0]} failed: ${msg}`);
  }
}

function gitWithIndex(root: string, indexFile: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 20 * 1024 * 1024,
    env: { ...process.env, GIT_INDEX_FILE: indexFile, LC_ALL: "C" },
  }).trim();
}

function hasStagedChanges(root: string): boolean {
  try {
    execFileSync("git", ["diff", "--cached", "--quiet", "--ignore-submodules=none", "--"], {
      cwd: root,
      stdio: ["ignore", "ignore", "pipe"],
      timeout: GIT_TIMEOUT_MS,
      env: { ...process.env, LC_ALL: "C" },
    });
    return false;
  } catch (e) {
    const err = e as { status?: number; stderr?: Buffer; message?: string };
    if (err.status === 1) return true;
    throw new Error(`Unable to inspect staged changes: ${err.stderr?.toString().trim() || err.message || String(e)}`);
  }
}

function gitResult(root: string, args: string[]): { status: number | null; stdout: string; stderr: string; error?: Error } {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 20 * 1024 * 1024,
    env: { ...process.env, LC_ALL: "C" },
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error,
  };
}

function checkpointsPath(root: string): string {
  return path.resolve(root, git(root, ["rev-parse", "--git-path", CHECKPOINTS_FILE]));
}

function readCheckpoints(root: string): CheckpointEntry[] {
  for (const file of [checkpointsPath(root), path.join(root, LEGACY_CHECKPOINTS_FILE)]) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
      if (Array.isArray(parsed)) return parsed as CheckpointEntry[];
    } catch {
      // Try the legacy worktree location, then report no checkpoints.
    }
  }
  return [];
}

function writeCheckpoints(root: string, entries: CheckpointEntry[]): void {
  const file = checkpointsPath(root);
  const temporary = `${file}.${process.pid}.tmp`;
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(temporary, JSON.stringify(entries, null, 2), "utf8");
  renameSync(temporary, file);
}

/**
 * Snapshot the full working tree (tracked + untracked) into a commit object
 * using a temporary index, then pin it under refs/bridge-checkpoints/<id> so
 * garbage collection can never prune it. The user's real index is never
 * touched.
 */
function snapshotCommit(root: string, head: string, id: string): string {
  const indexFile = path.join(tmpdir(), `bridge-idx-${process.pid}-${id}`);
  try {
    gitWithIndex(root, indexFile, ["read-tree", head]);
    gitWithIndex(root, indexFile, ["add", "-A"]);
    const tree = gitWithIndex(root, indexFile, ["write-tree"]);
    let commit: string;
    try {
      commit = git(root, ["commit-tree", tree, "-p", head, "-m", `bridge checkpoint ${id}`]);
    } catch (e) {
      if (/ident/i.test((e as Error).message)) {
        throw new Error(
          "Checkpoint needs a git identity to create the snapshot commit. Run:\n" +
            '  git config --global user.name "Your Name"\n' +
            "  git config --global user.email you@example.com",
        );
      }
      throw e;
    }
    git(root, ["update-ref", `${CHECKPOINTS_REF_PREFIX}${id}`, commit]);
    return commit;
  } finally {
    rmSync(indexFile, { force: true });
  }
}

/** Delete the pin ref for a dropped checkpoint entry. */
function dropCheckpointRef(root: string, id: string): void {
  git(root, ["update-ref", "-d", `${CHECKPOINTS_REF_PREFIX}${id}`], { allowFailure: true });
}

/** Capture HEAD + working tree (tracked + untracked). Safe to call repeatedly. */
export function createCheckpoint(root: string, note?: string, protectedId?: string): CheckpointEntry {
  requireGitTopLevel(root);
  const headResult = gitResult(root, ["rev-parse", "--verify", "HEAD"]);
  let head: string;
  if (headResult.status === 0) {
    head = headResult.stdout.trim();
  } else {
    const symbolic = gitResult(root, ["symbolic-ref", "-q", "HEAD"]);
    const ref = symbolic.status === 0 ? symbolic.stdout.trim() : "";
    const referenced = ref ? gitResult(root, ["show-ref", "--verify", "--quiet", ref]) : undefined;
    if (ref && referenced?.status === 1) {
      throw new NoCommitsError(
        "This repository has no commits yet — nothing to checkpoint against. " +
          "Make an initial commit first (git_commit after the first files exist).",
      );
    }
    throw new Error(`git rev-parse failed: ${headResult.stderr.trim() || headResult.error?.message || "invalid HEAD"}`);
  }

  const id = `${Date.now()}-${randomUUID()}`;
  const commit = snapshotCommit(root, head, id);
  const entry: CheckpointEntry = {
    id,
    base: head,
    commit,
    created_at: new Date().toISOString(),
    note,
  };

  const previous = readCheckpoints(root);
  const entries = [...previous, entry];
  const dropped: CheckpointEntry[] = [];
  while (entries.length > MAX_CHECKPOINTS) {
    const index = entries.findIndex((candidate) => candidate.id !== protectedId);
    if (index < 0) break;
    dropped.push(...entries.splice(index, 1));
  }
  writeCheckpoints(root, entries);
  // Unpin refs of entries dropped by the cap.
  for (const removed of dropped) {
    dropCheckpointRef(root, removed.id);
  }
  return entry;
}

export function checkpoint(args: CheckpointArgs): string {
  const root = resolveProjectDir(args.project, args.session_token);
  const entry = createCheckpoint(root, args.note);
  return (
    `Checkpoint ${entry.id} recorded on ${entry.base.slice(0, 12)}\n` +
    `- snapshot: ${entry.commit.slice(0, 12)} (pinned at ${CHECKPOINTS_REF_PREFIX}${entry.id})\n` +
    `- rollback with: rollback(project, session_token) (restores to this state; ` +
    `a fresh checkpoint is taken first, so the rollback is itself undoable)`
  );
}

/** Restore the working tree to a checkpoint. Destructive — user-confirmed. */
export function rollback(root: string, entry: CheckpointEntry): string {
  requireGitTopLevel(root);
  // Validate the checkpoint inventory before modifying the worktree.
  const inCheckpoint = new Set(
    git(root, ["ls-tree", "-rz", "--name-only", entry.commit], { raw: true })
      .split("\0")
      .filter(Boolean),
  );

  // Undoability: capture the current state without pruning the selected target.
  createCheckpoint(root, `auto before rollback to ${entry.id}`, entry.id);

  // Restore every file in the snapshot commit, then inventory and remove files
  // that are still untracked and did not exist in that checkpoint.
  git(root, ["restore", "--source", entry.commit, "--worktree", "--", "."]);
  const currentUntracked = git(root, ["ls-files", "-z", "--others", "--exclude-standard"], { raw: true })
    .split("\0")
    .filter(Boolean);
  for (const rel of currentUntracked) {
    if (!inCheckpoint.has(rel)) {
      rmSync(path.join(root, rel), { recursive: true, force: true });
    }
  }
  return (
    `Rolled back to checkpoint ${entry.id} (base ${entry.base.slice(0, 12)}).\n` +
    `The pre-rollback state was checkpointed first — rollback again to undo this.\n` +
    `Review with git_status / git_diff.`
  );
}

export function rollbackTool(args: RollbackArgs): string {
  const root = resolveProjectDir(args.project, args.session_token);
  requireGitTopLevel(root);
  const entries = readCheckpoints(root);
  if (entries.length === 0) {
    throw new Error("No checkpoints recorded for this project. Run checkpoint first.");
  }
  const entry = args.id ? entries.find((e) => e.id === args.id) : entries[entries.length - 1];
  if (!entry) {
    throw new Error(`Checkpoint "${args.id}" not found. Use checkpoints to list them.`);
  }
  return rollback(root, entry);
}

export function gitCommit(args: GitCommitArgs): string {
  const root = resolveProjectDir(args.project, args.session_token);
  requireGitTopLevel(root);
  if (!args.message || args.message.trim().length === 0) {
    throw new Error("A commit message is required.");
  }

  if (hasStagedChanges(root)) {
    const alreadyStaged = git(root, ["diff", "--cached", "--name-only", "-z", "--ignore-submodules=none"], { raw: true })
      .split("\0")
      .filter(Boolean)
      .map((file) => JSON.stringify(file))
      .join("\n");
    throw new Error(
      `Refusing to commit because the repository already has staged changes:\n${alreadyStaged}\n` +
        `Commit or unstage them first so cheap-labor cannot include unrelated work.`,
    );
  }

  const indexFile = path.resolve(root, git(root, ["rev-parse", "--git-path", "index"]));
  const indexBackup = `${indexFile}.cheap-labor-${randomUUID()}.bak`;
  const hadIndex = existsSync(indexFile);
  if (hadIndex) copyFileSync(indexFile, indexBackup);

  let staged = "";
  let retainIndexBackup = false;
  try {
    if (args.files && args.files.length > 0) {
      // Paths must live inside the approved project (boundary check).
      const checked = args.files.map((f) => {
        const { abs } = resolveInsideRoot(f, root);
        return path.relative(root, abs);
      });
      git(root, ["add", "--", EXCLUDE_PLAN_DIR, ...checked]);
    } else {
      // .codex-bridge/ is never staged — the bridge's working notes stay out
      // of the user's commit history.
      git(root, ["add", "-A", "--", EXCLUDE_PLAN_DIR]);
    }

    if (!hasStagedChanges(root)) {
      throw new Error("Nothing to commit — no changes were staged (note: .codex-bridge/ is excluded).");
    }
    staged = git(root, ["diff", "--cached", "--name-only", "-z", "--ignore-submodules=none"], { raw: true })
      .split("\0")
      .filter(Boolean)
      .join("\n");
    git(root, ["commit", "-m", args.message]);
  } catch (e) {
    try {
      if (hadIndex) renameSync(indexBackup, indexFile);
      else rmSync(indexFile, { force: true });
    } catch (restoreError) {
      retainIndexBackup = hadIndex && existsSync(indexBackup);
      throw new Error(
        `${(e as Error).message}\nAdditionally failed to restore the original git index: ${(restoreError as Error).message}` +
          (retainIndexBackup ? `\nThe original index backup is retained at ${indexBackup}.` : ""),
        { cause: e },
      );
    }
    throw e;
  } finally {
    if (!retainIndexBackup) rmSync(indexBackup, { force: true });
  }
  const sha = git(root, ["rev-parse", "--short", "HEAD"]);
  const files = staged.split("\n").filter(Boolean).join(", ");
  return (
    `Committed ${sha} — "${args.message}"\nFiles: ${files}\n` +
    `(.codex-bridge/ was excluded from the commit)\n\n` +
    `(pushing is intentionally not supported — do it yourself when ready)`
  );
}

export function checkpoints(args: CheckpointsArgs): string {
  const root = resolveProjectDir(args.project, args.session_token);
  requireGitTopLevel(root);
  const entries = readCheckpoints(root);
  if (entries.length === 0) {
    return "No checkpoints recorded for this project yet.";
  }
  return entries
    .map((e) => `- ${e.id}  ${e.created_at}  base ${e.base.slice(0, 12)}${e.note ? `  (${e.note})` : ""}`)
    .join("\n");
}
