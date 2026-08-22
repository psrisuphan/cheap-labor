import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { autoSafeApprovalPolicy } from "../src/approvals.js";
import { ElicitationInfo } from "../src/tools/codex.js";
import { ApprovalMode, setApprovalMode } from "../src/settings.js";

function info(message: string, mode: ElicitationInfo["mode"] = "form"): ElicitationInfo {
  return { mode, message };
}

function decisionFor(msg: string, mode: ApprovalMode, mode2: "form" | "url" = "form"): string {
  const dir = mkdtempSync(path.join(tmpdir(), "bridge-settings-"));
  const previous = process.env.BRIDGE_SETTINGS_FILE;
  process.env.BRIDGE_SETTINGS_FILE = path.join(dir, "settings.json");
  try {
    setApprovalMode(mode);
    return autoSafeApprovalPolicy(info(msg, mode2), mode).action;
  } finally {
    rmSync(dir, { recursive: true, force: true });
    if (previous === undefined) delete process.env.BRIDGE_SETTINGS_FILE;
    else process.env.BRIDGE_SETTINGS_FILE = previous;
  }
}

test("policy: safe allowlist commands are accepted in both modes", () => {
  assert.equal(decisionFor("Run `git status --short`", "normal"), "accept");
  assert.equal(decisionFor("git diff", "auto"), "accept");
  assert.equal(decisionFor("Run `ls -la`", "normal"), "accept");
  assert.equal(decisionFor("cat package.json", "auto"), "accept");
});

test("policy: dangerous commands are always declined, even in auto mode", () => {
  assert.equal(decisionFor("Run `rm -rf node_modules`", "normal"), "decline");
  assert.equal(decisionFor("Run `rm -rf node_modules`", "auto"), "decline");
  assert.equal(decisionFor("Run `git push --force`", "auto"), "decline");
  assert.equal(decisionFor("Run `npm install express`", "auto"), "decline");
  assert.equal(decisionFor("Run `python3 -c 'import os'`", "auto"), "decline");
  assert.equal(decisionFor("Run `bash -c 'rm -rf /'`", "auto"), "decline");
});

test("policy: judged commands are declined in normal mode, accepted in auto", () => {
  assert.equal(decisionFor("Run `node -v`", "normal"), "decline");
  assert.equal(decisionFor("Run `node -v`", "auto"), "accept");
  assert.equal(decisionFor("Run `npm test`", "auto"), "accept");
  assert.equal(decisionFor("Run `my-custom-binary --flag`", "auto"), "accept");
});

test("policy: url elicitations are always declined", () => {
  assert.equal(decisionFor("open https://example.com", "normal", "url"), "decline");
  assert.equal(decisionFor("open https://example.com", "auto", "url"), "decline");
});

test("policy: empty or prose-only messages are declined", () => {
  assert.equal(decisionFor("", "auto"), "decline");
  assert.equal(decisionFor("   ", "auto"), "decline");
  assert.equal(decisionFor("May I proceed with the current task?", "auto"), "decline");
});
