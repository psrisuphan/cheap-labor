import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { ApprovalMode, getApprovalMode, setApprovalMode, settingsPath } from "../src/settings.js";

function withSettingsDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), "bridge-settings-"));
  process.env.BRIDGE_SETTINGS_FILE = path.join(dir, "settings.json");
  try {
    fn(dir);
  } finally {
    delete process.env.BRIDGE_SETTINGS_FILE;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("settings: default mode is normal when no file exists", () => {
  withSettingsDir(() => {
    assert.equal(getApprovalMode(), "normal");
  });
});

test("settings: BRIDGE_SETTINGS_FILE is honored", () => {
  withSettingsDir((dir) => {
    const file = path.join(dir, "settings.json");
    assert.equal(settingsPath(), file);
  });
});

test("settings: set then get round-trips", () => {
  withSettingsDir((dir) => {
    setApprovalMode("auto");
    assert.equal(getApprovalMode(), "auto");
    const stored = JSON.parse(readFileSync(path.join(dir, "settings.json"), "utf8")) as {
      approvalMode: ApprovalMode;
    };
    assert.equal(stored.approvalMode, "auto");
  });
});

test("settings: file is written with 0600 permissions", () => {
  withSettingsDir((dir) => {
    const file = path.join(dir, "settings.json");
    setApprovalMode("auto");
    const mode = statSync(file).mode & 0o777;
    assert.equal(mode, 0o600);
  });
});

test("settings: unknown mode in file falls back to normal", () => {
  withSettingsDir((dir) => {
    const file = path.join(dir, "settings.json");
    setApprovalMode("normal");
    // Corrupt the file with an invalid mode.
    writeFileSync(file, JSON.stringify({ approvalMode: "bananas" }));
    assert.equal(getApprovalMode(), "normal");
  });
});

test("settings: corrupt file falls back to normal", () => {
  withSettingsDir((dir) => {
    writeFileSync(path.join(dir, "settings.json"), "not json {{{");
    assert.equal(getApprovalMode(), "normal");
  });
});