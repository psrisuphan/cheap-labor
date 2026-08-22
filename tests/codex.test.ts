import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assertCodexToolCompatibility,
  closeCodexServer,
  CodexServer,
  CodexServerFactory,
  getCodexServer,
  hasCodexServer,
} from "../src/tools/codex.js";

function fakeServer(onClose?: () => void): { server: CodexServer; close: () => void; closes: () => number } {
  let closeCount = 0;
  return {
    server: { close: async () => { closeCount++; } } as CodexServer,
    close: () => onClose?.(),
    closes: () => closeCount,
  };
}

test("Codex singleton startup is single-flight and closes once", async () => {
  await closeCodexServer();
  let starts = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let fake!: ReturnType<typeof fakeServer>;
  const factory: CodexServerFactory = async (onClose) => {
    starts++;
    fake = fakeServer(onClose);
    await gate;
    return fake.server;
  };

  const first = getCodexServer(factory);
  const second = getCodexServer(factory);
  assert.equal(starts, 1);
  release();
  assert.equal(await first, await second);
  assert.equal(hasCodexServer(), true);

  await closeCodexServer();
  assert.equal(fake.closes(), 1);
  assert.equal(hasCodexServer(), false);
});

test("Codex singleton retries after startup failure or child closure", async () => {
  await closeCodexServer();
  let attempts = 0;
  const failing: CodexServerFactory = async () => {
    attempts++;
    throw new Error("startup failed");
  };
  await assert.rejects(() => getCodexServer(failing), /startup failed/);
  assert.equal(hasCodexServer(), false);

  let fake!: ReturnType<typeof fakeServer>;
  const working: CodexServerFactory = async (onClose) => {
    attempts++;
    fake = fakeServer(onClose);
    return fake.server;
  };
  await getCodexServer(working);
  assert.equal(attempts, 2);
  fake.close();
  assert.equal(hasCodexServer(), false);
});

test("Codex singleton waits for shutdown before starting a replacement", async () => {
  await closeCodexServer();
  let starts = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const firstFactory: CodexServerFactory = async (onClose) => {
    starts++;
    const fake = fakeServer(onClose);
    await gate;
    return fake.server;
  };
  const secondFactory: CodexServerFactory = async (onClose) => {
    starts++;
    return fakeServer(onClose).server;
  };

  const first = getCodexServer(firstFactory);
  const closing = closeCodexServer();
  const replacement = getCodexServer(secondFactory);
  await Promise.resolve();
  assert.equal(starts, 1);
  release();
  await first;
  await closing;
  await replacement;
  assert.equal(starts, 2);
  await closeCodexServer();
});

test("Codex compatibility requires both bridge tools", () => {
  const codex = {
    name: "codex",
    inputSchema: {
      properties: {
        prompt: {}, sandbox: {}, cwd: {}, "approval-policy": {}, model: {}, config: {}, "developer-instructions": {},
      },
    },
  };
  const reply = {
    name: "codex-reply",
    inputSchema: { properties: { threadId: {}, prompt: {} } },
  };
  assert.doesNotThrow(() => assertCodexToolCompatibility([codex, reply]));
  assert.throws(() => assertCodexToolCompatibility([codex]), /missing tool codex-reply/);
  assert.throws(
    () => assertCodexToolCompatibility([codex, { ...reply, inputSchema: { properties: { prompt: {} } } }]),
    /codex-reply is missing input\(s\) threadId/,
  );
});
