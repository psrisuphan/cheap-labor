import { autoSafeApprovalPolicy } from "../approvals.js";
import { NotGitRepositoryError } from "../git.js";
import { readPlanFiles, renderPlanBlock } from "../planstore.js";
import { resolveProjectDir } from "../safety.js";
import { formatFindings } from "./deepExplore.js";
import { gitDiff } from "./context.js";
import { getCodexServer, guardModelOverride } from "./codex.js";
import { createCheckpoint, NoCommitsError } from "./ship.js";
import { z } from "zod";

import { projectSessionInputSchema } from "../safety.js";

export const implementInputSchema = projectSessionInputSchema.extend({
  task: z.string().describe("Detailed implementation instruction or pointer to the project plan files."),
  max_turns: z.number().int().min(1).max(10).optional().describe("Max Codex turns (default 5)."),
  model: z.string().optional().describe("Optional stronger Codex model."),
  model_confirmed: z.boolean().optional().describe("True after the requested model was explicitly confirmed."),
});
export type ImplementArgs = z.infer<typeof implementInputSchema>;

const DONE_MARKER = "IMPLEMENTATION COMPLETE";
const CONTINUE_PROMPT =
  "Continue working through the plan autonomously until it is complete. " +
  "Do not ask questions; make reasonable decisions. " +
  "When fully done, end your final message with the exact line: IMPLEMENTATION COMPLETE";

/**
 * Runs Codex (workspace-write) on the current plan. The plan comes from the
 * `task` argument plus any `.codex-bridge/` plan files ChatGPT has written.
 * Codex is positioned as a PURE EXECUTOR: the architect (ChatGPT) has already
 * decided everything — Codex follows the step-by-step instructions literally,
 * edits, runs builds/tests, fixes what breaks, then the final `git diff`
 * is appended so ChatGPT can review it with the free bridge tools.
 */
export async function implement(args: ImplementArgs): Promise<string> {
  const root = resolveProjectDir(args.project, args.session_token);

  guardModelOverride(args.model, args.model_confirmed);

  const plan = readPlanFiles(root);
  const planBlock = renderPlanBlock(plan);
  const maxTurns = Math.min(args.max_turns ?? 5, 10);

  // Safety net: every implement run starts from a rollback point.
  try {
    createCheckpoint(root, "auto before implement");
  } catch (e) {
    if (!(e instanceof NotGitRepositoryError) && !(e instanceof NoCommitsError)) throw e;
    // New projects can proceed before git initialization or their first commit.
  }

  const prompt = [
    `Execute the following detailed step-by-step plan in the repository rooted at "${root}":`,
    ``,
    args.task,
    planBlock,
    ``,
    `When everything is done, end your final message with the exact line: ${DONE_MARKER}`,
  ].join("\n");

  const server = await getCodexServer();
  let result = await server.run({
    prompt,
    sandbox: "workspace-write",
    cwd: root,
    model: args.model,
    onApproval: autoSafeApprovalPolicy,
    developerInstructions:
      "You are the executor in a ChatGPT-plans / Codex-executes workflow. " +
      "You are NOT the planner or designer. Follow the plan's step-by-step instructions " +
      "literally: make the specified edits, run the specified commands. Never think, " +
      "redesign, or expand scope; where the plan is silent, make the minimal possible " +
      "choice and note it. Fix only what breaks while executing. Verify your work " +
      "with the build/tests before finishing.",
  });

  let turns = 1;
  while (
    turns < maxTurns &&
    result.threadId &&
    !result.isError &&
    !result.text.includes(DONE_MARKER)
  ) {
    result = await server.reply(result.threadId, CONTINUE_PROMPT, autoSafeApprovalPolicy);
    turns++;
  }

  let out: string;
  if (result.isError) {
    out = `Codex reported an error after ${turns} turn(s):\n\n${result.text}`;
  } else {
    out = `Codex finished in ${turns} turn(s).\n\n` + result.text.trim();
  }
  out = formatFindings(out, result.approvals);

  // Review loop: append the resulting diff so ChatGPT can review it for free.
  try {
    const diff = await gitDiff({ project: args.project, session_token: args.session_token });
    out += `\n\n--- git diff (for ChatGPT review) ---\n${diff}`;
  } catch (e) {
    out += `\n\n(diff unavailable: ${(e as Error).message})`;
  }
  return out;
}
