import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const testHome = mkdtempSync(path.join(tmpdir(), "cheap-labor-tests-"));
process.env.CODEX_HOME = testHome;
process.env.BRIDGE_LEDGER_FILE = path.join(testHome, "approved-projects.json");
process.env.BRIDGE_SETTINGS_FILE = path.join(testHome, "settings.json");
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_AUTHOR_NAME = "Cheap Labor Tests";
process.env.GIT_AUTHOR_EMAIL = "tests@example.invalid";
process.env.GIT_COMMITTER_NAME = "Cheap Labor Tests";
process.env.GIT_COMMITTER_EMAIL = "tests@example.invalid";
process.on("exit", () => rmSync(testHome, { recursive: true, force: true }));
