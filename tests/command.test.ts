import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { runCommand } from "../src/tools/command.js";
import { ApprovalMode, setApprovalMode } from "../src/settings.js";
import { baseArgs, makeFixture } from "./helpers.js";

/** Run a test body with a specific approval mode written to an isolated settings file. */
async function withMode(mode: ApprovalMode, fn: () => Promise<void>): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), "bridge-settings-"));
  process.env.BRIDGE_SETTINGS_FILE = path.join(dir, "settings.json");
  setApprovalMode(mode);
  try {
    await fn();
  } finally {
    delete process.env.BRIDGE_SETTINGS_FILE;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("run_command: safe allowlist commands run without asking (both modes)", async () => {
  const f = makeFixture();
  try {
    await withMode("normal", async () => {
      const { text, needsApproval } = await runCommand({
        ...baseArgs(f),
        command: "git",
        args: ["status", "--short"],
      });
      assert.equal(needsApproval, false);
      assert.ok(text.includes("git status --short"));
    });
    await withMode("auto", async () => {
      const { needsApproval } = await runCommand({
        ...baseArgs(f),
        command: "git",
        args: ["diff"],
      });
      assert.equal(needsApproval, false);
    });
  } finally {
    f.cleanup();
  }
});

test("run_command: judged commands are refused without approval in normal mode", async () => {
  const f = makeFixture();
  try {
    await withMode("normal", async () => {
      const { text, needsApproval, risk } = await runCommand({
        ...baseArgs(f),
        command: "node",
        args: ["-v"],
      });
      assert.equal(needsApproval, true);
      assert.equal(risk, "read-only"); // judged: read-only but not allowlisted
      assert.ok(text.includes("Refused"));
      assert.ok(text.includes("NORMAL mode"));
    });
  } finally {
    f.cleanup();
  }
});

test("run_command: judged commands run with approved:true in normal mode", async () => {
  const f = makeFixture();
  try {
    await withMode("normal", async () => {
      const { text, needsApproval } = await runCommand({
        ...baseArgs(f),
        command: "node",
        args: ["-v"],
        approved: true,
      });
      assert.equal(needsApproval, false);
      assert.ok(text.includes("$ node -v"));
    });
  } finally {
    f.cleanup();
  }
});

test("run_command: auto mode asks the model to judge judged commands", async () => {
  const f = makeFixture();
  try {
    await withMode("auto", async () => {
      const { text, needsApproval } = await runCommand({
        ...baseArgs(f),
        command: "node",
        args: ["-v"],
      });
      assert.equal(needsApproval, true);
      assert.ok(text.includes("AUTO mode"));
      assert.ok(text.includes("judge"));
    });
  } finally {
    f.cleanup();
  }
});

test("run_command: auto mode runs judged commands the model approves", async () => {
  const f = makeFixture();
  try {
    await withMode("auto", async () => {
      const { needsApproval } = await runCommand({
        ...baseArgs(f),
        command: "node",
        args: ["-v"],
        approved: true,
      });
      assert.equal(needsApproval, false);
    });
  } finally {
    f.cleanup();
  }
});

test("run_command: dangerous commands always ask, even in auto mode", async () => {
  const f = makeFixture();
  try {
    await withMode("auto", async () => {
      const { text, needsApproval } = await runCommand({
        ...baseArgs(f),
        command: "rm",
        args: ["-rf", "/tmp/should-not-run"],
      });
      assert.equal(needsApproval, true);
      assert.ok(text.includes("dangerous command"));
      assert.ok(text.includes("explicit user approval"));
    });
  } finally {
    f.cleanup();
  }
});

test("run_command: dangerous commands run only with approved:true", async () => {
  const f = makeFixture();
  try {
    await withMode("auto", async () => {
      const target = path.join(f.root, "newfile.txt");
      const { needsApproval } = await runCommand({
        ...baseArgs(f),
        command: "touch",
        args: [path.relative(f.root, target)],
        approved: true,
      });
      assert.equal(needsApproval, false);
      assert.ok(existsSync(target));
    });
  } finally {
    f.cleanup();
  }
});

test("run_command: interpreter one-liners are dangerous (always ask)", async () => {
  const f = makeFixture();
  try {
    await withMode("auto", async () => {
      const { text, needsApproval, risk } = await runCommand({
        ...baseArgs(f),
        command: "python3",
        args: ["-c", "print(1)"],
      });
      assert.equal(needsApproval, true);
      assert.ok(risk !== "read-only");
      assert.ok(text.includes("dangerous command"));
    });
  } finally {
    f.cleanup();
  }
});

test("run_command: redacts secrets by default, opt-out available", async () => {
  const f = makeFixture();
  try {
    await withMode("normal", async () => {
      const { text } = await runCommand({
        ...baseArgs(f),
        command: "printf",
        args: ["TOKEN=sk-1234567890abcdefghijklmnop"],
      });
      assert.ok(!text.includes("sk-1234567890"));
      assert.ok(text.includes("[REDACTED]"));
      const raw = await runCommand({
        ...baseArgs(f),
        command: "printf",
        args: ["TOKEN=sk-1234567890abcdefghijklmnop"],
        redact_secrets: false,
      });
      assert.ok(raw.text.includes("sk-1234567890abcdefghijklmnop"));
    });
  } finally {
    f.cleanup();
  }
});

test("run_command: refuses without a project/session", async () => {
  await assert.rejects(() => runCommand({ command: "ls" }), /No project named/);
});