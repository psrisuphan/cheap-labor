import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import { implement } from "../src/tools/implement.js";
import { baseArgs, makeFixture, touchFile } from "./helpers.js";

test("implement: non-default model is refused without model_confirmed", async () => {
  const f = makeFixture();
  try {
    await assert.rejects(
      () => implement({ ...baseArgs(f), task: "do nothing", model: "gpt-5.6-sol" }),
      /Refused model "gpt-5.6-sol"/,
    );
  } finally {
    f.cleanup();
  }
});

test("implement: refuses a subtree of a larger git repository", async () => {
  const f = makeFixture();
  try {
    await assert.rejects(
      () => implement({ ...baseArgs(f), project: path.join(f.root, "src"), task: "do nothing" }),
      /Re-arm cheap-labor with the repository root/,
    );
  } finally {
    f.cleanup();
  }
});

test("implement: does not treat a corrupt HEAD as an uncommitted repository", async () => {
  const f = makeFixture();
  try {
    touchFile(f, ".git/HEAD", "not-a-valid-head\n");
    await assert.rejects(
      () => implement({ ...baseArgs(f), task: "do nothing" }),
      /Unable to resolve the git repository root/,
    );
  } finally {
    f.cleanup();
  }
});
