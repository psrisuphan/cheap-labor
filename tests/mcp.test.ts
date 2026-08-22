import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { buildServer } from "../src/index.js";
import { makeFixture } from "./helpers.js";

interface ToolResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

function resultText(result: ToolResult): string {
  return result.content.filter((item) => item.type === "text").map((item) => item.text ?? "").join("\n");
}

test("public MCP contract lists, validates, and executes tools", async (t) => {
  const server = buildServer();
  const client = new Client({ name: "cheap-labor-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const fixture = makeFixture();
  t.after(() => fixture.cleanup());
  t.after(async () => {
    await client.close();
    await server.close();
  });

  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  assert.equal(client.getServerVersion()?.name, "cheap-labor");

  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    [
      "checkpoint", "checkpoints", "codex_reply", "create_project", "deep_explore",
      "edit_file", "edit_pack", "find_projects", "get_settings", "git_commit",
      "git_diff", "git_log", "git_status", "grep", "implement", "init",
      "list_tree", "plan_read", "plan_write", "read_file", "rollback",
      "run_command", "set_approval_mode", "task_update", "write_file",
    ].sort(),
  );
  const planWrite = tools.find((tool) => tool.name === "plan_write");
  const fileSchema = (planWrite?.inputSchema.properties as Record<string, { enum?: string[] }> | undefined)?.file;
  assert.deepEqual(fileSchema?.enum, ["PLAN.md", "SPEC.md", "TASKS.md"]);

  const initialized = await client.callTool({ name: "init", arguments: { project: fixture.root } }) as ToolResult;
  const initializedText = resultText(initialized);
  const token = initializedText.match(/session_token: ([0-9a-f-]+)/)?.[1];
  assert.ok(token);
  assert.match(initializedText, /OPERATION MODE/);

  const read = await client.callTool({
    name: "read_file",
    arguments: { project: fixture.root, session_token: token, path: "README.md" },
  }) as ToolResult;
  assert.equal(read.isError, undefined);
  assert.match(resultText(read), /# Fixture/);

  const invalidPlan = await client.callTool({
    name: "plan_write",
    arguments: { project: fixture.root, session_token: token, file: "SECRET.txt", content: "x" },
  }) as ToolResult;
  assert.equal(invalidPlan.isError, true);

  const failedCommand = await client.callTool({
    name: "run_command",
    arguments: {
      project: fixture.root,
      session_token: token,
      command: "git",
      args: ["not-a-real-subcommand"],
      approved: true,
    },
  }) as ToolResult;
  assert.equal(failedCommand.isError, true);

  const created = await client.callTool({
    name: "create_project",
    arguments: { project: path.join(fixture.outside, "new-project") },
  }) as ToolResult;
  assert.match(resultText(created), /OPERATION MODE/);
});
