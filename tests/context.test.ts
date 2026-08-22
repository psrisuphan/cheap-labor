import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { gitDiff, gitLog, gitStatus, grep, listTree, readFile } from "../src/tools/context.js";
import { baseArgs, makeFixture, touchFile } from "./helpers.js";

test("list_tree: shows tree, skips hidden and node_modules by default", () => {
  const f = makeFixture();
  try {
    const out = listTree(baseArgs(f));
    assert.ok(out.includes("src/"));
    assert.ok(out.includes("README.md"));
    assert.ok(!out.includes(".git")); // hidden dirs skipped by default
    assert.ok(!out.includes("node_modules"));
    assert.ok(out.includes("blob.bin")); // files are listed regardless of content
  } finally {
    f.cleanup();
  }
});

test("list_tree: project argument selects the working directory", () => {
  const f = makeFixture();
  try {
    const out = listTree({ ...baseArgs(f),  project: path.join(f.root, "src") });
    assert.ok(out.includes("index.ts"));
    assert.ok(out.includes("nested/"));
    assert.ok(!out.includes("README.md")); // outside the named project
  } finally {
    f.cleanup();
  }
});

test("read_file: returns content with line metadata", () => {
  const f = makeFixture();
  try {
    const out = readFile({ ...baseArgs(f),  path: "src/index.ts" });
    assert.ok(out.includes("export function add"));
    assert.ok(out.includes("lines 1-6 of 6"));
    assert.ok(out.includes("file: src/index.ts"));
  } finally {
    f.cleanup();
  }
});

test("read_file: respects offset and limit", () => {
  const f = makeFixture();
  try {
    const out = readFile({ ...baseArgs(f),  path: "src/index.ts", offset: 3 });
    assert.ok(!out.includes("export function add"));
    assert.ok(out.includes("const greeting"));
    assert.ok(out.includes("lines 3-6 of 6"));
  } finally {
    f.cleanup();
  }
});

test("read_file: redacts secrets by default, opt-out available", () => {
  const f = makeFixture();
  try {
    touchFile(f, "env.txt", "OPENAI_API_KEY=sk-1234567890abcdefghijklmnop\nhello\n");
    const out = readFile({ ...baseArgs(f),  path: "env.txt" });
    assert.ok(out.includes("[REDACTED]"));
    assert.ok(!out.includes("sk-1234567890"));
    const raw = readFile({ ...baseArgs(f),  path: "env.txt", redact_secrets: false });
    assert.ok(raw.includes("sk-1234567890abcdefghijklmnop"));
  } finally {
    f.cleanup();
  }
});

test("read_file: refuses binary files", () => {
  const f = makeFixture();
  try {
    assert.throws(() => readFile({ ...baseArgs(f),  path: "assets/blob.bin" }), /binary/);
  } finally {
    f.cleanup();
  }
});

test("read_file: refuses paths outside the root", () => {
  const f = makeFixture();
  try {
    assert.throws(
      () => readFile({ ...baseArgs(f),  path: path.join(f.outside, "secret.txt") }),
      /outside the approved project/,
    );
  } finally {
    f.cleanup();
  }
});

test("grep: finds matches with line numbers", () => {
  const f = makeFixture();
  try {
    const out = grep({ ...baseArgs(f),  pattern: "export" });
    assert.ok(out.includes("src/index.ts:1:"));
    assert.ok(out.includes("src/util.ts:1:"));
  } finally {
    f.cleanup();
  }
});

test("grep: respects include globs", () => {
  const f = makeFixture();
  try {
    const out = grep({ ...baseArgs(f),  pattern: "export", include: ["util.ts"] });
    assert.ok(out.includes("src/util.ts"));
    assert.ok(!out.includes("src/index.ts"));
  } finally {
    f.cleanup();
  }
});

test("grep: include globs can target a path subtree", () => {
  const f = makeFixture();
  try {
    const out = grep({ ...baseArgs(f),  pattern: "export", include: ["src/**/*.ts"] });
    assert.ok(out.includes("src/nested/deep.ts"));
    assert.ok(out.includes("src/index.ts"));
    assert.ok(!out.includes("README.md")); // not a .ts file, and outside src/
  } finally {
    f.cleanup();
  }
});

test("grep: no matches reports cleanly", () => {
  const f = makeFixture();
  try {
    const out = grep({ ...baseArgs(f),  pattern: "zzz_nothing_here" });
    assert.ok(out.includes("No matches"));
  } finally {
    f.cleanup();
  }
});

test("grep: redacts secrets by default, opt-out available", () => {
  const f = makeFixture();
  try {
    touchFile(f, "env.txt", "TOKEN=sk-1234567890abcdefghijklmnop\nhello\n");
    const out = grep({ ...baseArgs(f),  pattern: "TOKEN" });
    assert.ok(out.includes("[REDACTED]"));
    assert.ok(!out.includes("sk-1234567890"));
    const raw = grep({ ...baseArgs(f),  pattern: "TOKEN", redact_secrets: false });
    assert.ok(raw.includes("sk-1234567890abcdefghijklmnop"));
  } finally {
    f.cleanup();
  }
});

test("grep: skips oversized files and reports the skip", () => {
  const f = makeFixture();
  try {
    const big = path.join(f.root, "src", "big.dat");
    mkdirSync(path.dirname(big), { recursive: true });
    writeFileSync(big, "export const NEEDLE = true;\n" + "x".repeat(3 * 1024 * 1024));
    const out = grep({ ...baseArgs(f),  pattern: "NEEDLE" });
    assert.ok(out.includes("large file(s) skipped"));
    assert.ok(!out.includes("big.dat:1:")); // never read into memory
  } finally {
    f.cleanup();
  }
});

test("git_status: clean tree reports clean", async () => {
  const f = makeFixture();
  try {
    const out = await gitStatus(baseArgs(f));
    assert.ok(out.includes("clean"));
  } finally {
    f.cleanup();
  }
});

test("git_status: shows modified files", async () => {
  const f = makeFixture();
  try {
    touchFile(f, "src/util.ts", "export const VERSION = \"2.0.0\";\n");
    const out = await gitStatus(baseArgs(f));
    assert.ok(out.includes("src/util.ts"));
  } finally {
    f.cleanup();
  }
});

test("git_diff: shows unstaged changes", async () => {
  const f = makeFixture();
  try {
    touchFile(f, "src/util.ts", "export const VERSION = \"2.0.0\";\n");
    const out = await gitDiff(baseArgs(f));
    assert.ok(out.includes("-export const VERSION = \"1.0.0\";"));
    assert.ok(out.includes("+export const VERSION = \"2.0.0\";"));
  } finally {
    f.cleanup();
  }
});

test("git_diff: surfaces untracked files", async () => {
  const f = makeFixture();
  try {
    touchFile(f, "newfile.txt", "brand new\n");
    const out = await gitDiff(baseArgs(f));
    assert.ok(out.includes("untracked files"));
    assert.ok(out.includes("newfile.txt"));
  } finally {
    f.cleanup();
  }
});

test("git_diff: cached shows staged changes only", async () => {
  const f = makeFixture();
  try {
    touchFile(f, "src/util.ts", "export const VERSION = \"2.0.0\";\n", true);
    const unstaged = await gitDiff(baseArgs(f));
    const staged = await gitDiff({ ...baseArgs(f),  cached: true });
    assert.ok(unstaged.includes("no unstaged changes"));
    assert.ok(staged.includes("+export const VERSION = \"2.0.0\";"));
  } finally {
    f.cleanup();
  }
});

test("git_log: shows fixture commit", async () => {
  const f = makeFixture();
  try {
    const out = await gitLog(baseArgs(f));
    assert.ok(out.includes("fixture init"));
  } finally {
    f.cleanup();
  }
});

test("git tools: refuse an approved subtree of a larger repository", async () => {
  const f = makeFixture();
  try {
    await assert.rejects(
      () => gitStatus({ ...baseArgs(f), project: path.join(f.root, "src") }),
      /Re-arm cheap-labor with the repository root/,
    );
  } finally {
    f.cleanup();
  }
});
