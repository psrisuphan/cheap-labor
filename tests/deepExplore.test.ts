import assert from "node:assert/strict";
import { test } from "node:test";

import { FIXED_CODEX_MODEL, guardModelOverride } from "../src/tools/codex.js";

test("guardModelOverride: no model (default) is always allowed", () => {
  assert.doesNotThrow(() => guardModelOverride(undefined, undefined));
});

test("guardModelOverride: the fixed default model is always allowed", () => {
  assert.doesNotThrow(() => guardModelOverride(FIXED_CODEX_MODEL, false));
});

test("guardModelOverride: a non-default model is refused without confirmation", () => {
  assert.throws(() => guardModelOverride("gpt-5.6-sol", undefined), /Refused model "gpt-5.6-sol"/);
  assert.throws(() => guardModelOverride("gpt-5.6-sol", false), /Refused model "gpt-5.6-sol"/);
});

test("guardModelOverride: a non-default model is allowed only with model_confirmed", () => {
  assert.doesNotThrow(() => guardModelOverride("gpt-5.6-sol", true));
});