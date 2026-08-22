import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { initProject } from "../src/projects.js";
import { checkpoint, checkpoints, gitCommit, rollbackTool } from "../src/tools/ship.js";
import { baseArgs, makeFixture, touchFile } from "./helpers.js";

function git(f: ReturnType<typeof makeFixture>, args: string[]): string {
  return execFileSync("git", ["-C", f.root, ...args], { encoding: "utf8" }).trim();
}

test("checkpoint + rollback: restores modified tracked files", () => {
  const f = makeFixture();
  try {
    touchFile(f, "src/index.ts", "const greeting = \"before\";\n");
    checkpoint(baseArgs(f));

    touchFile(f, "src/index.ts", "const greeting = \"after\";\n");
    assert.ok(readFileSync(path.join(f.root, "src", "index.ts"), "utf8").includes("after"));

    const out = rollbackTool(baseArgs(f));
    assert.ok(out.includes("Rolled back"));
    assert.ok(readFileSync(path.join(f.root, "src", "index.ts"), "utf8").includes("before"));
  } finally {
    f.cleanup();
  }
});

test("checkpoint metadata survives rollback and makes rollback undoable", () => {
  const f = makeFixture();
  try {
    touchFile(f, "src/index.ts", "const state = \"before\";\n");
    checkpoint(baseArgs(f));
    const metadata = git(f, ["rev-parse", "--git-path", "cheap-labor/checkpoints.json"]);
    assert.ok(existsSync(path.resolve(f.root, metadata)));
    assert.ok(!existsSync(path.join(f.root, ".codex-bridge", "checkpoints.json")));

    touchFile(f, "src/index.ts", "const state = \"after\";\n");
    rollbackTool(baseArgs(f));
    assert.match(checkpoints(baseArgs(f)), /auto before rollback/);

    rollbackTool(baseArgs(f));
    assert.equal(readFileSync(path.join(f.root, "src", "index.ts"), "utf8"), "const state = \"after\";\n");
  } finally {
    f.cleanup();
  }
});

test("rollback protects an explicitly selected oldest checkpoint at the cap", () => {
  const f = makeFixture();
  try {
    touchFile(f, "src/index.ts", "const state = \"oldest\";\n");
    const oldest = checkpoint({ ...baseArgs(f), note: "oldest" }).match(/^Checkpoint (\S+)/)?.[1];
    assert.ok(oldest);
    for (let i = 1; i < 20; i++) checkpoint({ ...baseArgs(f), note: `later-${i}` });

    touchFile(f, "src/index.ts", "const state = \"current\";\n");
    rollbackTool({ ...baseArgs(f), id: oldest });

    assert.equal(readFileSync(path.join(f.root, "src", "index.ts"), "utf8"), "const state = \"oldest\";\n");
    assert.match(checkpoints(baseArgs(f)), new RegExp(oldest));
    assert.equal(git(f, ["for-each-ref", "--format=%(refname)", "refs/bridge-checkpoints"]).split("\n").length, 20);
  } finally {
    f.cleanup();
  }
});

test("checkpoint: pins the snapshot under refs/bridge-checkpoints (gc-safe)", () => {
  const f = makeFixture();
  try {
    touchFile(f, "src/index.ts", "const greeting = \"pinned\";\n");
    checkpoint(baseArgs(f));
    const refs = git(f, ["for-each-ref", "--format=%(refname)", "refs/bridge-checkpoints"]);
    assert.equal(refs.split("\n").filter(Boolean).length, 1);
    // The ref points at a commit containing the checkpointed content.
    const sha = git(f, ["for-each-ref", "--format=%(objectname)", "refs/bridge-checkpoints"]);
    const content = git(f, ["show", `${sha}:src/index.ts`]);
    assert.ok(content.includes("pinned"));
  } finally {
    f.cleanup();
  }
});

test("checkpoint: drops refs beyond the cap of 20", () => {
  const f = makeFixture();
  try {
    for (let i = 0; i < 22; i++) {
      checkpoint({ ...baseArgs(f), note: `n${i}` });
    }
    const refs = git(f, ["for-each-ref", "--format=%(refname)", "refs/bridge-checkpoints"]);
    assert.equal(refs.split("\n").filter(Boolean).length, 20);
  } finally {
    f.cleanup();
  }
});

test("rollback: removes files created after the checkpoint", () => {
  const f = makeFixture();
  try {
    checkpoint(baseArgs(f));
    touchFile(f, "src/created-after.ts", "new file\n");
    assert.ok(existsSync(path.join(f.root, "src", "created-after.ts")));

    rollbackTool(baseArgs(f));
    assert.ok(!existsSync(path.join(f.root, "src", "created-after.ts")));
  } finally {
    f.cleanup();
  }
});

test("rollback: removes post-checkpoint paths with leading whitespace", () => {
  const f = makeFixture();
  try {
    checkpoint(baseArgs(f));
    touchFile(f, " leading-space.txt", "new file\n");
    rollbackTool(baseArgs(f));
    assert.ok(!existsSync(path.join(f.root, " leading-space.txt")));
  } finally {
    f.cleanup();
  }
});

test("rollback: restores untracked files that existed at checkpoint time", () => {
  const f = makeFixture();
  try {
    touchFile(f, "scratch-notes.txt", "notes v1\n");
    checkpoint(baseArgs(f));

    touchFile(f, "scratch-notes.txt", "notes v2\n");
    rollbackTool(baseArgs(f));
    assert.equal(readFileSync(path.join(f.root, "scratch-notes.txt"), "utf8"), "notes v1\n");
  } finally {
    f.cleanup();
  }
});

test("rollback: preserves restored files across a file-to-directory transition", () => {
  const f = makeFixture();
  try {
    touchFile(f, "swapped/file.txt", "checkpoint content\n");
    checkpoint(baseArgs(f));

    rmSync(path.join(f.root, "swapped"), { recursive: true });
    touchFile(f, "swapped", "later file\n");
    rollbackTool(baseArgs(f));

    assert.equal(readFileSync(path.join(f.root, "swapped", "file.txt"), "utf8"), "checkpoint content\n");
  } finally {
    f.cleanup();
  }
});

test("checkpoint + rollback: no checkpoints recorded errors cleanly", () => {
  const f = makeFixture();
  try {
    assert.throws(() => rollbackTool(baseArgs(f)), /No checkpoints recorded/);
    const out = checkpoints(baseArgs(f));
    assert.ok(out.includes("No checkpoints"));
  } finally {
    f.cleanup();
  }
});

test("git_commit: stages and commits with the given message", () => {
  const f = makeFixture();
  try {
    touchFile(f, "src/committed.ts", "export const x = 1;\n");
    const out = gitCommit({ ...baseArgs(f), message: "add committed.ts" });
    assert.ok(out.includes("Committed"));
    assert.ok(out.includes("add committed.ts"));

    const log = git(f, ["log", "-1", "--format=%s"]);
    assert.equal(log, "add committed.ts");
    const status = git(f, ["status", "--porcelain"]);
    assert.equal(status, "");
  } finally {
    f.cleanup();
  }
});

test("git_commit: refuses to include pre-existing staged work", () => {
  const f = makeFixture();
  try {
    touchFile(f, "src/already-staged.ts", "export const staged = true;\n", true);
    touchFile(f, "src/requested.ts", "export const requested = true;\n");

    assert.throws(
      () => gitCommit({ ...baseArgs(f), message: "requested only", files: ["src/requested.ts"] }),
      /already has staged changes/,
    );
    assert.equal(git(f, ["diff", "--cached", "--name-only"]), "src/already-staged.ts");
    assert.equal(git(f, ["log", "-1", "--format=%s"]), "fixture init");
  } finally {
    f.cleanup();
  }
});

test("git_commit: detects a staged whitespace-only filename", () => {
  const f = makeFixture();
  try {
    touchFile(f, "   ", "staged\n", true);
    touchFile(f, "src/requested.ts", "export const requested = true;\n");
    assert.throws(
      () => gitCommit({ ...baseArgs(f), message: "requested only", files: ["src/requested.ts"] }),
      /already has staged changes/,
    );
    assert.equal(git(f, ["log", "-1", "--format=%s"]), "fixture init");
  } finally {
    f.cleanup();
  }
});

test("git_commit: restores a clean index after commit failure", () => {
  const f = makeFixture();
  try {
    touchFile(f, "src/requested.ts", "export const requested = true;\n");
    touchFile(f, "src/intent.ts", "export const intent = true;\n");
    git(f, ["add", "-N", "src/intent.ts"]);
    const indexFile = path.resolve(f.root, git(f, ["rev-parse", "--git-path", "index"]));
    const indexBefore = readFileSync(indexFile);
    const hook = path.join(f.root, ".git", "hooks", "pre-commit");
    touchFile(f, ".git/hooks/pre-commit", "#!/bin/sh\nexit 1\n");
    chmodSync(hook, 0o755);

    assert.throws(() => gitCommit({ ...baseArgs(f), message: "must fail" }), /git commit failed/);
    assert.equal(git(f, ["diff", "--cached", "--name-only"]), "");
    assert.deepEqual(readFileSync(indexFile), indexBefore);
    assert.ok(existsSync(path.join(f.root, "src", "requested.ts")));
  } finally {
    f.cleanup();
  }
});

test("git_commit: .codex-bridge/ is never staged", () => {
  const f = makeFixture();
  try {
    touchFile(f, "src/committed.ts", "export const x = 1;\n");
    touchFile(f, ".codex-bridge/PLAN.md", "# secret working plan\n");
    touchFile(f, ".codex-bridge/checkpoints.json", "[]\n");

    gitCommit({ ...baseArgs(f), message: "code only" });
    const committed = git(f, ["ls-files"]);
    assert.ok(!committed.includes(".codex-bridge"));
    assert.ok(committed.includes("src/committed.ts"));

    // Even when files are passed explicitly, .codex-bridge stays out.
    touchFile(f, "src/two.ts", "export const y = 2;\n");
    gitCommit({ ...baseArgs(f), message: "second", files: ["src/two.ts", ".codex-bridge/PLAN.md"] });
    const committed2 = git(f, ["ls-files"]);
    assert.ok(!committed2.includes(".codex-bridge"));
    assert.ok(committed2.includes("src/two.ts"));
  } finally {
    f.cleanup();
  }
});

test("git_commit: .codex-bridge-only changes produce 'nothing to commit'", () => {
  const f = makeFixture();
  try {
    touchFile(f, ".codex-bridge/PLAN.md", "# plan only\n");
    assert.throws(() => gitCommit({ ...baseArgs(f), message: "only plans" }), /Nothing to commit/);
  } finally {
    f.cleanup();
  }
});

test("git_commit: refuses when nothing is staged", () => {
  const f = makeFixture();
  try {
    assert.throws(() => gitCommit({ ...baseArgs(f), message: "nothing here" }), /Nothing to commit/);
  } finally {
    f.cleanup();
  }
});

test("checkpoint: requires at least one commit in the repo", () => {
  const f = makeFixture();
  try {
    const fresh = path.join(f.outside, "empty-repo");
    execFileSync("git", ["init", "-q", fresh]);
    const token = initProject(fresh).session_token;
    assert.throws(
      () => checkpoint({ project: fresh, session_token: token }),
      /no commits yet/,
    );
  } finally {
    f.cleanup();
  }
});
