#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import { autoSafeApprovalPolicy } from "./approvals.js";
import { createProject, findProjects, initProject } from "./projects.js";
import { projectSessionInputSchema, resolveProjectDir } from "./safety.js";
import { approvalModeSchema, getApprovalMode, setApprovalMode } from "./settings.js";
import { closeCodexServer, getCodexServer, hasCodexServer } from "./tools/codex.js";
import {
  gitDiff,
  gitDiffInputSchema,
  gitLog,
  gitLogInputSchema,
  gitStatus,
  gitStatusInputSchema,
  grep,
  grepInputSchema,
  listTree,
  listTreeInputSchema,
  readFile as readFileTool,
  readFileInputSchema,
} from "./tools/context.js";
import { runCommand, runCommandInputSchema } from "./tools/command.js";
import { deepExplore, deepExploreInputSchema, formatFindings } from "./tools/deepExplore.js";
import {
  editFile,
  editFileInputSchema,
  editPack,
  editPackInputSchema,
  writeFile,
  writeFileInputSchema,
} from "./tools/edit.js";
import { implement, implementInputSchema } from "./tools/implement.js";
import {
  planRead,
  planReadInputSchema,
  planWrite,
  planWriteInputSchema,
  taskUpdate,
  taskUpdateInputSchema,
} from "./tools/plans.js";
import {
  checkpoint,
  checkpointInputSchema,
  checkpoints,
  checkpointsInputSchema,
  gitCommit,
  gitCommitInputSchema,
  rollbackInputSchema,
  rollbackTool,
} from "./tools/ship.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isMain = (() => {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isMain && (process.argv.includes("--help") || process.argv.includes("-h"))) {
  console.log(
    [
      "cheap-labor — MCP server (stdio)",
      "",
      "Usage: cheap-labor",
      "",
      "The bridge is dormant until armed inside the ChatGPT session: the user",
      "@-mentions cheap-labor, confirms a project, and init issues a per-chat",
      "token. No startup arguments are needed.",
    ].join("\n"),
  );
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

function packageVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(path.join(__dirname, "..", "package.json"), "utf8"),
    ) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

// Server-wide guidance (MCP `instructions`, sent to the client at initialize).
// Deliberately tiny: while dormant, the model should spend ZERO attention on
// this server. The full workflow rules are carried in the init tool's result
// instead, so they only enter the conversation AFTER the user explicitly
// invokes cheap-labor. No prompt monitoring: the invocation is the trigger.
const SERVER_INSTRUCTIONS = [
  "cheap-labor is DORMANT. Ignore these tools entirely — no need to consider them when answering. " +
    "The session is armed only when the user explicitly invokes cheap-labor with an @cheap-labor mention. " +
    "When that happens, ASK the user which project they want to work on and wait for their answer — " +
    "do not call any tool (especially find_projects) before they name it. If they name an EXISTING project, " +
    "resolve it with find_projects, show the candidate(s), ask 'is this the correct directory?', then call init. " +
    "If they ask to CREATE a new directory (e.g. 'create a folder called X on my Desktop'), resolve the absolute " +
    "path yourself (expand ~; interpret 'Desktop', 'Documents', etc. as under their home directory) and call " +
    "create_project with it directly — do NOT ask for the absolute path again and do NOT suggest shell commands " +
    "like mkdir; their creation request IS the confirmation. create_project returns a session_token and arms " +
    "the chat exactly like init. Follow the OPERATION MODE it returns. Never call any cheap-labor tool unless the user mentioned it.",
  "",
  "Approval mode (get_settings to read it; set_approval_mode to change it): only act when the user explicitly mentions cheap-labor AND asks for it — e.g. '@cheap-labor, switch to auto mode'. A plain 'switch to auto mode' prompt without the mention is NOT an invocation; the bridge is dormant, so ignore it.",
  "- normal (default): before running ANY command via run_command that is not on the provably-safe allowlist, ask the user for permission and retry with approved:true only after they say yes.",
  "- auto: judge run_command requests yourself. Run commands you judge safe (pass approved:true on your own judgment), but ALWAYS ask the user first for dangerous ones — file deletion/overwrite, git rewrites, network installs/fetches, interpreter one-liners (python -c, node -e, bash -c) — and retry with approved:true only after they say yes.",
  "The same rule applies to Codex approvals surfaced in results: relay them to the user for a veto (codex_reply).",
  "Model upgrades (implement / deep_explore): the default Codex model (gpt-5.6-luna) is always used. When it keeps failing, you may PROPOSE a stronger model (e.g. gpt-5.6-sol) and ask the user — but a non-default model is refused unless the user explicitly agreed to that exact model and you pass model_confirmed: true. Per-call: every non-default model run needs its own confirmation. Never pick a model on your own.",
].join("\n");

export function buildServer(): McpServer {
const server = new McpServer(
  {
    name: "cheap-labor",
    version: packageVersion(),
  },
  { instructions: SERVER_INSTRUCTIONS },
);

// ---- M0: session trigger (the single entry point) ---------------------------

/** The "operation mode" payload init returns: re-primes the chat for work. */
function armedSessionMessage(project: string, token: string): string {
  const mode = getApprovalMode();
  return [
    `CHEAP-LABOR ARMED — this chat is now in work mode.`,
    ``,
    `Project: ${project}`,
    `session_token: ${token}`,
    `approval mode: ${mode}`,
    ``,
    `OPERATION MODE (applies for the rest of this chat):`,
    `- Pass this token together with the project path on EVERY bridge tool call.`,
    `- Role split: you (ChatGPT) think, plan, and review. Codex NEVER thinks or designs — it executes your instructions literally.`,
    `- Tool priority: free tools first (list_tree, read_file, grep, git_status, git_diff, git_log, plan_read, plan_write, task_update, run_command); small edits yourself with write_file / edit_file / edit_pack (free); deep_explore only when free tools can't answer (read-only Codex, costs usage); implement only for heavy multi-file work after writing the plan (workspace-write Codex, costs usage).`,
    `- Workflow: understand with git_status + list_tree + read_file/grep → write the detailed step-by-step plan into .codex-bridge/ with plan_write → make small edits yourself, delegate heavy multi-file work to implement → review the returned git diff → correct via the same loop.`,
    `- Plan in full detail before delegating: exact files, changes, commands, verification — never "we'll add feature X".`,
    `- Approvals: relay Codex approval logs to the user; continue via codex_reply only after their decision. In ${mode} mode: ${mode === "normal"
      ? "ask the user before running any command via run_command that isn't on the safe allowlist (retry with approved:true only after they say yes)."
      : "judge safe run_command requests yourself (approved:true), but always ask the user first for dangerous ones (deletes, git rewrites, network installs, interpreter one-liners)."} Never push or run anything destructive without explicit user approval.`,
    `- Ship mode: checkpoint before risky batches (implement takes one automatically); git_commit commits locally after user approval (never pushes); rollback is undoable.`,
    `- New chat = dormant again: the user must @-mention cheap-labor to re-arm.`,
  ].join("\n");
}

server.registerTool(
  "init",
  {
    description:
      "Arm the workflow for this chat: approves an EXISTING project and returns the session_token every other tool needs. Call only after the user @-mentions cheap-labor, names a project, and confirms the exact directory. For a NEW directory use create_project (it arms the chat too). Never call unless mentioned.",
    inputSchema: z.object({
      project: z.string().describe("Absolute path to the project (must exist and be a directory, user-confirmed)."),
    }),
  },
  async (args) => {
    const { project, session_token: token } = initProject(args.project);
    return {
      content: [{ type: "text", text: armedSessionMessage(project, token) }],
    };
  },
);

// ---- M1: context tools (deterministic local I/O, no Codex cost) ------------

server.registerTool(
  "find_projects",
  {
    description:
      "Resolve a fuzzy project name (e.g. 'the app on my Desktop') to candidate paths. Scans only shallow well-known locations (home, Desktop, Documents, Projects, Developer, code, dev, src, workspace), max 2 levels deep, skipping hidden dirs. Free local I/O. Use ONLY after the user has named a project in chat — never preemptively — then show candidates to the user and ask which is the correct directory before calling init.",
    inputSchema: z.object({
      query: z.string().optional().describe("Substring to match against directory names (case-insensitive). Empty lists all candidates."),
    }),
  },
  async (args) => {
    const candidates = findProjects(args.query ?? "");
    if (candidates.length === 0) {
      return {
        content: [
          {
            type: "text",
            text:
              `No directories matched${args.query ? ` "${args.query}"` : ""} in the usual locations ` +
              `(home, Desktop, Documents, Projects, Developer, code, dev, src, workspace). ` +
              `Ask the user for the exact path, or if they want a NEW directory, resolve the path and call create_project.`,
          },
        ],
      };
    }
    const lines = candidates.map((c) => `- ${c.name}\t${c.path}`);
    return {
      content: [
        {
          type: "text",
          text:
            `${candidates.length} candidate(s)${args.query ? ` for "${args.query}"` : ""}:\n` +
            lines.join("\n") +
            `\n\nShow these to the user and let them confirm the right one before calling init.`,
        },
      ],
    };
  },
);

server.registerTool(
  "create_project",
  {
    description:
      "Create a brand-new project DIRECTORY (git is NOT initialized — that's up to the user). Returns a session_token and arms the chat exactly like init — no second ask, the user's creation request IS the confirmation. Call when the user explicitly asks to create a new directory: resolve the absolute path yourself (expand ~; interpret 'Desktop', 'Documents', etc. as under the home directory), then call this directly. Never suggest shell commands like mkdir instead. Refuses paths that already exist and paths whose parent directory doesn't exist.",
    inputSchema: z.object({
      project: z.string().describe("Absolute path for the NEW project directory (must not exist yet; its parent must exist)."),
    }),
  },
  async (args) => {
    const { created, session_token: token } = createProject(args.project);
    return {
      content: [
        {
          type: "text",
          text:
            `Created: ${created}\n\n` +
            armedSessionMessage(created, token) +
            `\n\n` +
            `(git is not initialized — run "git init" in the project when you want version control)`,
        },
      ],
    };
  },
);


server.registerTool(
  "set_approval_mode",
  {
    description:
      "Change the global approval mode. normal = ask the user before any command outside the safe allowlist. auto = judge safe commands yourself (approved:true), but ALWAYS ask the user first for dangerous ones (file deletion/overwrite, git rewrites, network installs, interpreter one-liners). Call only when the user explicitly mentions cheap-labor and asks (e.g. '@cheap-labor, switch to auto mode'). Read the new mode back to confirm.",
    inputSchema: z.object({
      mode: approvalModeSchema.describe("normal (ask first) or auto (judge safe commands yourself)."),
    }),
  },
  async (args) => {
    const mode = setApprovalMode(args.mode);
    return {
      content: [
        {
          type: "text",
          text:
            `Approval mode is now ${mode}.\n\n` +
            `- normal: ask the user before running any command outside the safe allowlist (retry with approved:true only after they say yes).\n` +
            `- auto: judge safe commands yourself; ALWAYS ask the user first for dangerous ones (file deletion/overwrite, git rewrites, network installs, interpreter one-liners).\n\n` +
            `Read this to the user to confirm the change.`,
        },
      ],
    };
  },
);

server.registerTool(
  "get_settings",
  {
    description:
      "Read current bridge settings — mainly the approval mode (normal = ask the user first; auto = judge safe commands yourself, always ask for dangerous ones). Free local I/O. Useful before running commands to know whether to ask the user or judge.",
    inputSchema: z.object({}),
  },
  async () => {
    const mode = getApprovalMode();
    return { content: [{ type: "text", text: `approval mode: ${mode}` }] };
  },
);

server.registerTool(
  "list_tree",
  {
    description:
      "List the directory structure under a path inside a project root. Free local I/O — prefer over deep_explore for any directory layout question.",
    inputSchema: listTreeInputSchema,
  },
  async (args) => {
    const text = listTree(args ?? {});
    return { content: [{ type: "text", text }] };
  },
);

server.registerTool(
  "read_file",
  {
    description:
      "Read a file inside a project root, size-capped and line-ranged. Free local I/O — prefer over deep_explore for any file-content question. Refuses binary files and paths outside the approved project.",
    inputSchema: readFileInputSchema,
  },
  async (args) => {
    const text = readFileTool(args);
    return { content: [{ type: "text", text }] };
  },
);

server.registerTool(
  "grep",
  {
    description:
      "Regex search across files under a path inside a project root. Skips hidden dirs, node_modules, .git, binaries. Free local I/O — prefer over deep_explore for locating symbols/strings.",
    inputSchema: grepInputSchema,
  },
  async (args) => {
    const text = grep(args);
    return { content: [{ type: "text", text }] };
  },
);

server.registerTool(
  "git_status",
  {
    description:
      "Working-tree status of a project root via git. Free local I/O — the first thing to check before planning or reviewing.",
    inputSchema: gitStatusInputSchema,
  },
  async (args) => {
    const text = await gitStatus(args ?? {});
    return { content: [{ type: "text", text }] };
  },
);

server.registerTool(
  "git_diff",
  {
    description:
      "git diff inside a project root (unstaged by default). Free local I/O — the review loop: ChatGPT reads this and decides next steps.",
    inputSchema: gitDiffInputSchema,
  },
  async (args) => {
    const text = await gitDiff(args ?? {});
    return { content: [{ type: "text", text }] };
  },
);

server.registerTool(
  "git_log",
  {
    description:
      "Recent commit history (oneline) of a project root. Free local I/O.",
    inputSchema: gitLogInputSchema,
  },
  async (args) => {
    const text = await gitLog(args ?? {});
    return { content: [{ type: "text", text }] };
  },
);

// ---- M3: workflow tools (plans + risk-gated commands) ------------------------

server.registerTool(
  "plan_read",
  {
    description:
      "Read the .codex-bridge/ handoff files (PLAN.md, SPEC.md, TASKS.md) that carry the ChatGPT → Codex plan. Free local I/O.",
    inputSchema: planReadInputSchema,
  },
  async (args) => {
    const text = planRead(args ?? {});
    return { content: [{ type: "text", text }] };
  },
);

server.registerTool(
  "plan_write",
  {
    description:
      "Write a .codex-bridge/ plan file (PLAN.md, SPEC.md, or TASKS.md). Replaces the file's entire contents. This is the handoff: implement picks these up on its next run. Plans must be detailed step-by-step instructions (exact files, changes, commands, verification) so Codex can execute them literally without thinking.",
    inputSchema: planWriteInputSchema,
  },
  async (args) => {
    const text = planWrite(args);
    return { content: [{ type: "text", text }] };
  },
);

server.registerTool(
  "task_update",
  {
    description:
      "Update a task's status in .codex-bridge/TASKS.md (todo / in-progress / done / blocked). Matches by substring. Errors if the task line isn't found — TASKS.md is authored via plan_write, so add tasks by rewriting the file.",
    inputSchema: taskUpdateInputSchema,
  },
  async (args) => {
    const text = taskUpdate(args);
    return { content: [{ type: "text", text }] };
  },
);

server.registerTool(
  "write_file",
  {
    description:
      "Create a NEW file directly (free — no Codex usage). Parent directories are created inside the approved project as needed. Refuses to overwrite existing files (use edit_file for changes). Content is written exactly as given. Use this for small, well-defined additions ChatGPT can make itself; delegate large multi-file work to implement.",
    inputSchema: writeFileInputSchema,
  },
  async (args) => {
    const text = writeFile(args);
    return { content: [{ type: "text", text }] };
  },
);

server.registerTool(
  "edit_file",
  {
    description:
      "Edit an existing file directly via exact-match replacement (free — no Codex usage). The search text must match the file's current content exactly, once (or set replace_all) — a stale or ambiguous match refuses with nothing written, so re-read the file and retry. Use for small, well-defined edits ChatGPT can make itself; delegate large multi-file work to implement.",
    inputSchema: editFileInputSchema,
  },
  async (args) => {
    const text = editFile(args);
    return { content: [{ type: "text", text }] };
  },
);

server.registerTool(
  "edit_pack",
  {
    description:
      "Batch several edits and/or new files in one validation-first operation (free — no Codex usage). All guards validate before writes begin, so validation failures write nothing. An unexpected I/O failure while applying can leave earlier files changed. Use for small, well-defined batches; max 20 items.",
    inputSchema: editPackInputSchema,
  },
  async (args) => {
    const text = editPack(args);
    return { content: [{ type: "text", text }] };
  },
);

server.registerTool(
  "checkpoint",
  {
    description:
      "Snapshot the current repo state (HEAD + working tree, tracked AND untracked) into a local checkpoint so it can be rolled back. Free local git plumbing — no Codex cost. Take one before risky edits or implement runs (implement takes one automatically). Never touches branches, history, or remotes.",
    inputSchema: checkpointInputSchema,
  },
  async (args) => {
    const text = checkpoint(args);
    return { content: [{ type: "text", text }] };
  },
);

server.registerTool(
  "rollback",
  {
    description:
      "Restore the working tree to a checkpoint (default: the latest). DESTRUCTIVE — call ONLY after the user explicitly approved the rollback in chat. Takes a fresh checkpoint of the current state first, so the rollback itself can be undone by rolling back again.",
    inputSchema: rollbackInputSchema,
  },
  async (args) => {
    const text = rollbackTool(args);
    return { content: [{ type: "text", text }] };
  },
);

server.registerTool(
  "git_commit",
  {
    description:
      "Stage the named files (or all changes) and commit them with the given message. .codex-bridge/ is NEVER staged — plans and checkpoints stay out of history. Call ONLY after the user approved the message and the files in chat. Never pushes.",
    inputSchema: gitCommitInputSchema,
  },
  async (args) => {
    const text = gitCommit(args);
    return { content: [{ type: "text", text }] };
  },
);

server.registerTool(
  "checkpoints",
  {
    description:
      "List recorded checkpoints for this project (free local git plumbing).",
    inputSchema: checkpointsInputSchema,
  },
  async (args) => {
    const text = checkpoints(args);
    return { content: [{ type: "text", text }] };
  },
);

server.registerTool(
  "run_command",
  {
    description:
      "Run a command (tests, build, typecheck) in a project. No shell — executable and args separately. The safe allowlist (git status/log/diff/show, ls, cat, pwd, echo, grep, rg, sort, uniq, wc, head, tail, printf, date) runs directly; dangerous commands (file deletes, git rewrites, network installs, interpreter one-liners like python -c / node -e / bash -c) ALWAYS require approval — approved:true only after the user said yes. Others depend on the approval mode (get_settings): normal = ask first (approved:true after yes); auto = judge it yourself.",
    inputSchema: runCommandInputSchema,
  },
  async (args) => {
    const { text, ok } = await runCommand(args);
    return { content: [{ type: "text", text }], isError: !ok };
  },
);
// ---- M2: Codex-backed tools (spawn official codex mcp-server) ---------------

server.registerTool(
  "deep_explore",
  {
    description:
      "Fallback for questions the free bridge tools can't answer (e.g. 'trace how auth is wired across 30 files'). Runs the official codex mcp-server in a READ-ONLY sandbox with capped scope; findings only. Costs Codex usage — always try list_tree/read_file/grep/git_* first.",
    inputSchema: deepExploreInputSchema,
  },
  async (args) => {
    const text = await deepExplore(args);
    return { content: [{ type: "text", text }] };
  },
);

server.registerTool(
  "implement",
  {
    description:
      "Run Codex (workspace-write sandbox) on the current task: it reads .codex-bridge/ plan files, edits the repo, runs builds/tests, fixes breakage, then appends the git diff for ChatGPT to review. The plan must be a DETAILED step-by-step plan (exact files, changes, commands) — Codex executes it literally, never thinks or designs. Provide it in task OR in the .codex-bridge/ plan files — NOT both; if plan files exist, keep task a short pointer to them. Only call after ChatGPT has written that plan. Costs Codex usage (default gpt-5.6-luna; stronger model only per-call with model_confirmed: true).",
    inputSchema: implementInputSchema,
  },
  async (args) => {
    const text = await implement(args);
    return { content: [{ type: "text", text }] };
  },
);

server.registerTool(
  "codex_reply",
  {
    description:
      "Continue an existing Codex session by thread id. Used to relay approval decisions ('The user approved: <cmd>' / 'The user denied: <cmd>; proceed without it') and to push a session forward. Thread ids come from implement/deep_explore results and are bound to the project that created them — pass that project and its session token, or the call is refused.",
    inputSchema: projectSessionInputSchema.extend({
      threadId: z.string().describe("Thread id of the session to continue."),
      prompt: z.string().describe("The next user message for Codex (e.g. the user's approval decision)."),
    }),
  },
  async (args) => {
    const root = resolveProjectDir(args.project, args.session_token);
    // Threads live only in this process — after a restart none can exist, so
    // don't spawn the codex child just to reject a stale thread id.
    if (!hasCodexServer()) {
      return {
        content: [
          {
            type: "text",
            text: `codex_reply failed: unknown or expired thread "${args.threadId}". Threads are not valid across bridge restarts.`,
          },
        ],
        isError: true,
      };
    }
    const server = await getCodexServer();
    const threadRoot = server.rootForThread(args.threadId);
    if (threadRoot === undefined) {
      return {
        content: [
          {
            type: "text",
            text: `codex_reply failed: unknown or expired thread "${args.threadId}". Threads belong to the chat that created them.`,
          },
        ],
        isError: true,
      };
    }
    if (threadRoot !== root) {
      return {
        content: [
          {
            type: "text",
            text: `codex_reply failed: thread "${args.threadId}" belongs to a different project — refusing to continue it here.`,
          },
        ],
        isError: true,
      };
    }
    const result = await server.reply(args.threadId, args.prompt, autoSafeApprovalPolicy);
    if (result.isError) {
      return { content: [{ type: "text", text: `codex_reply failed: ${result.text}` }], isError: true };
    }
    const text = formatFindings(result.text, result.approvals);
    return { content: [{ type: "text", text }] };
  },
);

return server;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

async function runServer(): Promise<void> {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);

  const shutdown = (): void => {
    void Promise.all([server.close(), closeCodexServer()]).finally(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

if (isMain) await runServer();
