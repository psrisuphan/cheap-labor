import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { planRead, planWrite, planWriteInputSchema, taskUpdate } from "../src/tools/plans.js";
import { baseArgs, makeFixture } from "./helpers.js";

test("plan_write creates .codex-bridge files, plan_read reads them back", () => {
  const f = makeFixture();
  try {
    const out = planWrite({ ...baseArgs(f),  file: "PLAN.md", content: "# Plan\n\nDo the thing.\n" });
    assert.ok(out.includes(".codex-bridge"));
    assert.ok(existsSync(path.join(f.root, ".codex-bridge", "PLAN.md")));

    const read = planRead({ ...baseArgs(f),  file: "PLAN.md" });
    assert.ok(read.includes("# Plan"));
    assert.ok(read.includes("Do the thing."));
  } finally {
    f.cleanup();
  }
});

test("plan_write with project: plan files land in the named project dir", () => {
  const f = makeFixture();
  try {
    const project = path.join(f.root, "src");
    planWrite({ ...baseArgs(f),  project, file: "PLAN.md", content: "# Subproject plan\n" });
    assert.ok(existsSync(path.join(project, ".codex-bridge", "PLAN.md")));
    assert.ok(!existsSync(path.join(f.root, ".codex-bridge", "PLAN.md")));
    const read = planRead({ ...baseArgs(f),  project, file: "PLAN.md" });
    assert.ok(read.includes("Subproject plan"));
  } finally {
    f.cleanup();
  }
});

test("plan_write refuses unknown file names", () => {
  const f = makeFixture();
  try {
    const parsed = planWriteInputSchema.safeParse({ ...baseArgs(f), file: "SECRET.txt", content: "x" });
    assert.equal(parsed.success, false);
  } finally {
    f.cleanup();
  }
});

test("plan_read reports when no plan files exist", () => {
  const f = makeFixture();
  try {
    const out = planRead(baseArgs(f));
    assert.ok(out.includes("No plan files yet"));
  } finally {
    f.cleanup();
  }
});

test("task_update updates an existing task line", () => {
  const f = makeFixture();
  try {
    planWrite({ ...baseArgs(f),  file: "TASKS.md", content: "- [ ] build the bridge\n- [x] write the plan\n" });
    const out = taskUpdate({ ...baseArgs(f),  task: "build the bridge", status: "done" });
    assert.ok(out.includes("→ done"));
    const tasks = readFileSync(path.join(f.root, ".codex-bridge", "TASKS.md"), "utf8");
    assert.ok(tasks.includes("- [x] build the bridge"));
    assert.ok(tasks.includes("- [x] write the plan")); // untouched
  } finally {
    f.cleanup();
  }
});

test("task_update errors when the task is not found (no appends)", () => {
  const f = makeFixture();
  try {
    planWrite({ ...baseArgs(f),  file: "TASKS.md", content: "- [ ] build the bridge\n" });
    assert.throws(
      () => taskUpdate({ ...baseArgs(f),  task: "add tests", status: "in-progress" }),
      /was not found/,
    );
    const tasks = readFileSync(path.join(f.root, ".codex-bridge", "TASKS.md"), "utf8");
    assert.equal(tasks, "- [ ] build the bridge\n"); // unchanged
  } finally {
    f.cleanup();
  }
});

test("task_update handles numbered, plain-bullet, and checkbox-only lines", () => {
  const f = makeFixture();
  try {
    planWrite({
      ...baseArgs(f),
      file: "TASKS.md",
      content: "1. write the plan\n- implement the bridge\n[ ] review the diff\n",
    });
    taskUpdate({ ...baseArgs(f),  task: "write the plan", status: "done" });
    taskUpdate({ ...baseArgs(f),  task: "implement the bridge", status: "in-progress" });
    taskUpdate({ ...baseArgs(f),  task: "review the diff", status: "blocked" });
    const tasks = readFileSync(path.join(f.root, ".codex-bridge", "TASKS.md"), "utf8");
    assert.ok(tasks.includes("- [x] write the plan"));
    assert.ok(tasks.includes("- [~] implement the bridge"));
    assert.ok(tasks.includes("- [!] review the diff"));
  } finally {
    f.cleanup();
  }
});
