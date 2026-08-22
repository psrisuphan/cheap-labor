import { autoSafeApprovalPolicy } from "../approvals.js";
import { projectSessionInputSchema, resolveProjectDir } from "../safety.js";
import { getCodexServer, guardModelOverride } from "./codex.js";
import { z } from "zod";

export const deepExploreInputSchema = projectSessionInputSchema.extend({
  question: z.string().describe("The question to investigate."),
  path: z.string().optional().describe("Restrict scope to a path inside the root."),
  model: z.string().optional().describe("Optional stronger Codex model."),
  model_confirmed: z.boolean().optional().describe("True after the requested model was explicitly confirmed."),
});
export type DeepExploreArgs = z.infer<typeof deepExploreInputSchema>;

/**
 * Fallback for questions the free bridge tools can't answer (e.g. "trace how
 * auth is wired across 30 files"). Runs Codex with a read-only sandbox and
 * capped scope; returns findings only — no edits, no design decisions.
 */
export async function deepExplore(args: DeepExploreArgs): Promise<string> {
  const root = resolveProjectDir(args.project, args.session_token);

  guardModelOverride(args.model, args.model_confirmed);

  const scope = args.path && args.path !== "." ? `"${args.path}"` : "the whole project root";

  const prompt = [
    `Investigate this question about the repository rooted at "${root}", scoped to ${scope}:`,
    ``,
    args.question,
    ``,
    `Do NOT modify any files. Do NOT run commands that write or have side effects.`,
    `Report concrete findings with file:line references. Be concise;`,
    `if the answer is uncertain, say so and what would disambiguate it.`,
  ].join("\n");

  const server = await getCodexServer();
  const result = await server.run({
    prompt,
    sandbox: "read-only",
    cwd: root,
    model: args.model,
    onApproval: autoSafeApprovalPolicy,
    developerInstructions:
      "You are a read-only research agent. Investigate, then answer with findings only. Never edit files.",
  });

  if (result.isError) {
    throw new Error(`deep_explore failed: ${result.text || "unknown Codex error"}`);
  }
  return formatFindings(result.text, result.approvals);
}

/** Attach the approval log so ChatGPT can relay decisions to the user. */
export function formatFindings(text: string, approvals: string[]): string {
  const body = text.trim();
  if (approvals.length === 0) return body;
  return (
    body +
    "\n\n--- approval log (relay to the user; veto via codex_reply) ---\n" +
    approvals.join("\n")
  );
}
