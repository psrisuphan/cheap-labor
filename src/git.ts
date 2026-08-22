import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

const GIT_TIMEOUT_MS = 30_000;

export class NotGitRepositoryError extends Error {}
export class GitRootMismatchError extends Error {}

/** Require the approved project to be the repository root, not a subtree. */
export function requireGitTopLevel(root: string): string {
  let reported: string;
  try {
    reported = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: GIT_TIMEOUT_MS,
      env: { ...process.env, LC_ALL: "C" },
    }).trim();
  } catch (e) {
    const err = e as { stderr?: string; message?: string };
    const message = err.stderr?.trim() || err.message || String(e);
    if (/not a git repository/i.test(message) && !existsSync(path.join(root, ".git"))) {
      throw new NotGitRepositoryError(`"${root}" is not inside a git repository.`);
    }
    throw new Error(`Unable to resolve the git repository root for "${root}": ${message}`);
  }

  const topLevel = realpathSync(reported);
  if (topLevel !== root) {
    throw new GitRootMismatchError(
      `The approved project "${root}" is inside the git repository "${topLevel}". ` +
        `Re-arm cheap-labor with the repository root so git tools cannot affect sibling directories.`,
    );
  }
  return topLevel;
}
