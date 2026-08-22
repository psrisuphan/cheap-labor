import assert from "node:assert/strict";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { createProject, findProjects, initProject, ledgerPath, recordProject } from "../src/projects.js";
import {
  bucketCommand,
  isWithin,
  resolveInsideRoot,
  resolveProjectDir,
  sliceLines,
  splitCommandLine,
  truncateText,
} from "../src/safety.js";
import { makeFixture } from "./helpers.js";

test("isWithin: parent contains child, not siblings", () => {
  assert.ok(isWithin("/a/b", "/a/b"));
  assert.ok(isWithin("/a/b", "/a/b/c/d"));
  assert.ok(!isWithin("/a/b", "/a/bc"));
  assert.ok(!isWithin("/a/b", "/a"));
});

test("resolveInsideRoot: relative path resolves inside the project", () => {
  const f = makeFixture();
  try {
    const { abs, root } = resolveInsideRoot("src/index.ts", f.root);
    assert.equal(root, f.root);
    assert.equal(abs, path.join(f.root, "src", "index.ts"));
  } finally {
    f.cleanup();
  }
});

test("resolveInsideRoot: refuses paths outside the approved project", () => {
  const f = makeFixture();
  try {
    assert.throws(
      () => resolveInsideRoot(f.outside, f.root),
      /outside the approved project/,
    );
    // Traversal attempts are also refused.
    assert.throws(() => resolveInsideRoot("../..", f.root), /outside the approved project/);
  } finally {
    f.cleanup();
  }
});

test("truncateText: keeps short text, truncates long text with a marker", () => {
  assert.equal(truncateText("short", 100), "short");
  const long = "x".repeat(1000);
  const out = truncateText(long, 100);
  assert.ok(out.includes("truncated"));
  assert.ok(out.length < 300);
  // Head and tail are both preserved.
  assert.ok(out.startsWith("xxxxx"));
  assert.ok(out.endsWith("xxxxx"));
});

test("sliceLines: 1-indexed inclusive range", () => {
  const text = "a\nb\nc\nd\ne";
  assert.equal(sliceLines(text, 2, 3), "b\nc");
  assert.equal(sliceLines(text, undefined, 2), "a\nb");
  assert.equal(sliceLines(text, 4), "d\ne");
});

test("resolveProjectDir: no project named asks the user", () => {
  assert.throws(() => resolveProjectDir(undefined), /No project named/);
  assert.throws(() => resolveProjectDir("   "), /No project named/);
});

test("resolveProjectDir: no project named points at the @-mention trigger, no intent judging", () => {
  assert.throws(() => resolveProjectDir(undefined), /@cheap-labor/);
  assert.throws(() => resolveProjectDir(undefined), /@cheap-labor/);
  assert.throws(() => resolveProjectDir(undefined), /answer the user without any bridge tools/);
});

test("resolveProjectDir: project without approval is denied with guidance", () => {
  const f = makeFixture();
  try {
    assert.throws(() => resolveProjectDir(f.root), /requires in-session approval/);
    assert.throws(() => resolveProjectDir(path.join(f.root, "src")), /requires in-session approval/);
  } finally {
    f.cleanup();
  }
});

test("resolveProjectDir: unarmed refusal is terse — mention only, no offer", () => {
  const f = makeFixture();
  try {
    assert.throws(() => resolveProjectDir(f.root), /@cheap-labor/);
    assert.throws(() => resolveProjectDir(f.root), /session is not armed/);
  } finally {
    f.cleanup();
  }
});

test("resolveProjectDir: session token grants access to the approved project", () => {
  const f = makeFixture();
  try {
    const project = f.outside;
    assert.throws(() => resolveProjectDir(project), /requires in-session approval/);

    const token = initProject(project).session_token;
    assert.equal(resolveProjectDir(project, token), realpathSync(project));
    // The token also covers subdirectories of the approved project.
    const sub = path.join(project, "src");
    assert.equal(resolveProjectDir(sub, token), path.join(realpathSync(project), "src"));
  } finally {
    f.cleanup();
  }
});

test("resolveProjectDir: wrong or foreign token is refused", () => {
  const f = makeFixture();
  try {
    const token = initProject(f.outside).session_token;
    assert.throws(() => resolveProjectDir(f.outside, "not-a-token"), /does not match project/);
    // A token issued for project A cannot open project B.
    assert.throws(() => resolveProjectDir(f.root, token), /does not match project/);
    // And the refusal points back at the @-mention.
    assert.throws(() => resolveProjectDir(f.root, token), /@cheap-labor/);
  } finally {
    f.cleanup();
  }
});

test("initProject: arms the session for an existing project", () => {
  const f = makeFixture();
  try {
    const { project, session_token: token } = initProject(f.root);
    assert.equal(project, realpathSync(f.root));
    // The token works like an init token.
    assert.equal(resolveProjectDir(project, token), project);
    const sub = path.join(project, "src");
    assert.equal(resolveProjectDir(sub, token), path.join(realpathSync(project), "src"));
  } finally {
    f.cleanup();
  }
});

test("initProject: refuses nonexistent or non-directory paths", () => {
  const f = makeFixture();
  try {
    assert.throws(() => initProject(path.join(f.root, "does-not-exist")), /does not exist/);
    assert.throws(() => initProject(path.join(f.root, "README.md")), /not a directory/);
  } finally {
    f.cleanup();
  }
});

test("initProject: issues a fresh token per arming (per-chat semantics)", () => {
  const f = makeFixture();
  try {
    const first = initProject(f.root);
    const second = initProject(f.root);
    assert.notEqual(first.session_token, second.session_token);
    assert.equal(resolveProjectDir(f.root, first.session_token), first.project);
    assert.equal(resolveProjectDir(f.root, second.session_token), second.project);
  } finally {
    f.cleanup();
  }
});

test("initProject: refuses nonexistent or non-directory paths", () => {
  const f = makeFixture();
  try {
    assert.throws(() => initProject(path.join(f.root, "does-not-exist")), /does not exist/);
    assert.throws(() => initProject(path.join(f.root, "README.md")), /not a directory/);
  } finally {
    f.cleanup();
  }
});

test("ledger: approvals are recorded (deduped) to the ledger file", () => {
  const f = makeFixture();
  try {
    const ledger = path.join(f.outside, "ledger.json");
    process.env.BRIDGE_LEDGER_FILE = ledger;

    recordProject(f.root);
    recordProject(f.root); // duplicate — deduped
    recordProject(path.join(f.root, "src"));
    const entries = JSON.parse(readFileSync(ledger, "utf8")) as string[];
    assert.deepEqual(entries, [path.join(f.root, "src"), f.root]);

    // initProject records too
    const before = entries.length;
    initProject(f.root);
    const after = JSON.parse(readFileSync(ledger, "utf8")) as string[];
    assert.equal(after.length, before); // f.root already present
  } finally {
    delete process.env.BRIDGE_LEDGER_FILE;
    f.cleanup();
  }
});

test("ledger: BRIDGE_LEDGER_FILE is honored", () => {
  const f = makeFixture();
  try {
    const ledger = path.join(f.outside, "custom-ledger.json");
    process.env.BRIDGE_LEDGER_FILE = ledger;
    assert.equal(ledgerPath(), ledger);
  } finally {
    delete process.env.BRIDGE_LEDGER_FILE;
    f.cleanup();
  }
});

test("findProjects: matches fuzzy names under given search roots", () => {
  const f = makeFixture();
  try {
    const searchRoot = path.join(f.root, "..");
    const hits = findProjects("bridge-test", [searchRoot]);
    assert.ok(hits.length >= 1);
    assert.ok(hits.some((c) => c.name.startsWith("bridge-test-")));

    const none = findProjects("zzz-no-such-project", [searchRoot]);
    assert.equal(none.length, 0);
  } finally {
    f.cleanup();
  }
});

test("createProject: creates a directory (no git init) + returns a working token", () => {
  const f = makeFixture();
  try {
    const newProject = path.join(f.outside, "brand-new-app");
    const { created, session_token: token } = createProject(newProject);
    assert.equal(created, realpathSync(newProject));
    // The user asked for a plain directory — no .git, no commits.
    assert.ok(!existsSync(path.join(created, ".git")));
    // The returned token grants access for the session.
    assert.equal(resolveProjectDir(created, token), created);
  } finally {
    f.cleanup();
  }
});

test("createProject: refuses existing paths and missing parents", () => {
  const f = makeFixture();
  try {
    assert.throws(() => createProject(f.root), /already exists/);
    assert.throws(
      () => createProject(path.join(f.root, "no-such-parent", "app")),
      /Parent directory .* does not exist/,
    );
  } finally {
    f.cleanup();
  }
});

test("splitCommandLine: handles quotes and preserves arguments", () => {
  assert.deepEqual(splitCommandLine("git status --short"), { command: "git", args: ["status", "--short"] });
  assert.deepEqual(splitCommandLine("echo 'hello world'"), { command: "echo", args: ["hello world"] });
  assert.deepEqual(splitCommandLine('printf "%s" a'), { command: "printf", args: ["%s", "a"] });
  assert.deepEqual(splitCommandLine("ls"), { command: "ls", args: [] });
  assert.deepEqual(splitCommandLine(""), { command: "", args: [] });
});

test("bucketCommand: provably-safe allowlist is 'safe'", () => {
  assert.equal(bucketCommand("git", ["status", "--short"]), "safe");
  assert.equal(bucketCommand("git", ["diff"]), "safe");
  assert.equal(bucketCommand("git", ["log", "--oneline", "-5"]), "safe");
  assert.equal(bucketCommand("git", ["rev-parse", "--show-toplevel"]), "safe");
  assert.equal(bucketCommand("git", ["config", "--get", "user.name"]), "safe");
  assert.equal(bucketCommand("ls", ["-la"]), "safe");
  assert.equal(bucketCommand("cat", ["package.json"]), "safe");
  assert.equal(bucketCommand("pwd", []), "safe");
  assert.equal(bucketCommand("echo", ["hi"]), "safe");
  assert.equal(bucketCommand("grep", ["-r", "foo", "."]), "safe");
  assert.equal(bucketCommand("rg", ["foo"]), "safe");
});

test("bucketCommand: git mutations are 'ask'", () => {
  assert.equal(bucketCommand("git", ["add", "."]), "ask");
  assert.equal(bucketCommand("git", ["commit", "-m", "x"]), "ask");
  assert.equal(bucketCommand("git", ["push", "--force"]), "ask");
  assert.equal(bucketCommand("git", ["reset", "--hard"]), "ask");
  assert.equal(bucketCommand("git", ["rebase", "main"]), "ask");
  assert.equal(bucketCommand("git", ["clean", "-fd"]), "ask");
  assert.equal(bucketCommand("git", ["config", "--global", "user.name", "x"]), "judged");
});

test("bucketCommand: file deletes, network, redirects are 'ask'", () => {
  assert.equal(bucketCommand("rm", ["-rf", "node_modules"]), "ask");
  assert.equal(bucketCommand("shred", ["-u", "file"]), "ask");
  assert.equal(bucketCommand("curl", ["-L", "https://example.com"]), "ask");
  assert.equal(bucketCommand("wget", ["https://example.com"]), "ask");
  assert.equal(bucketCommand("npm", ["install", "express"]), "ask");
  assert.equal(bucketCommand("sudo", ["rm", "x"]), "ask");
});

test("bucketCommand: interpreter one-liners are 'ask', including shells", () => {
  assert.equal(bucketCommand("python3", ["-c", "print(1)"]), "ask");
  assert.equal(bucketCommand("node", ["-e", "console.log(1)"]), "ask");
  assert.equal(bucketCommand("node", ["--eval", "console.log(1)"]), "ask");
  assert.equal(bucketCommand("bash", ["-c", "rm -rf /"]), "ask");
  assert.equal(bucketCommand("sh", ["-c", "echo hi"]), "ask");
  assert.equal(bucketCommand("zsh", ["-c", "ls"]), "ask");
  // Quoted one-liners must stay dangerous too — the wrapper is the danger.
  assert.equal(bucketCommand("bash", ["-c", "'ls'"]), "ask");
  assert.equal(bucketCommand("sh", ["-c", "'echo hi'"]), "ask");
  // Combined short flags (-lc / -le) are caught as well.
  assert.equal(bucketCommand("zsh", ["-lc", "'ls'"]), "ask");
  assert.equal(bucketCommand("bash", ["-lc", "'npm test'"]), "ask");
});

test("bucketCommand: everything else is 'judged'", () => {
  assert.equal(bucketCommand("node", ["-v"]), "judged");
  assert.equal(bucketCommand("npm", ["test"]), "judged");
  assert.equal(bucketCommand("npm", ["run", "typecheck"]), "judged");
  assert.equal(bucketCommand("tsc", ["--noEmit"]), "judged");
  assert.equal(bucketCommand("git", ["config", "--global", "user.name", "x"]), "judged");
});
