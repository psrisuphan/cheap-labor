import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { initProject } from "../src/projects.js";

export interface Fixture {
  root: string;
  /** Session token approving `root` for this fixture (per-chat model). */
  token: string;
  /** Absolute path to a dir outside the root, for refusal tests. */
  outside: string;
  cleanup: () => void;
}

/** Arguments every tool call must pass (project + session token). */
export function baseArgs(f: Fixture): { project: string; session_token: string } {
  return { project: f.root, session_token: f.token };
}

/** Create a temp project with a small file tree and a git repo, approved. */
export function makeFixture(): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), "bridge-test-"));
  const outside = mkdtempSync(path.join(tmpdir(), "bridge-outside-"));
  const cleanup = () => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  };

  try {
    mkdirSync(path.join(root, "src", "nested"), { recursive: true });
    mkdirSync(path.join(root, "assets"), { recursive: true });
    mkdirSync(path.join(root, "node_modules"), { recursive: true });
    writeFileSync(path.join(root, "README.md"), "# Fixture\n\nhello world\n");
    writeFileSync(
      path.join(root, "src", "index.ts"),
      "export function add(a: number, b: number): number {\n  return a + b;\n}\n\nconst greeting = \"hello\";\n",
    );
    writeFileSync(path.join(root, "src", "util.ts"), "export const VERSION = \"1.0.0\";\n");
    writeFileSync(path.join(root, "src", "nested", "deep.ts"), "export const deep = true;\n");
    // Binary-ish file (NUL byte) that read_file must refuse.
    writeFileSync(path.join(root, "assets", "blob.bin"), Buffer.from([0x00, 0x01, 0x02, 0x66, 0x6f, 0x6f]));
    writeFileSync(path.join(outside, "secret.txt"), "top secret");

    execFileSync("git", ["init", "-q", root]);
    execFileSync("git", ["-C", root, "add", "-A"]);
    execFileSync("git", ["-C", root, "commit", "-q", "-m", "fixture init"]);
  } catch (e) {
    cleanup();
    throw e;
  }

  const canonicalRoot = realpathSync(root);
  return {
    root: canonicalRoot,
    token: initProject(canonicalRoot).session_token,
    outside,
    cleanup,
  };
}

/** Modify a file inside the fixture (and optionally stage it). */
export function touchFile(fixture: Fixture, rel: string, content: string, stage = false): void {
  const abs = path.join(fixture.root, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  if (stage) execFileSync("git", ["-C", fixture.root, "add", rel]);
}
