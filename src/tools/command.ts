import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";

import {
  bucketCommand,
  classifyCommand,
  CommandRisk,
  projectSessionInputSchema,
  redactSecrets,
  resolveProjectDir,
  truncateText,
} from "../safety.js";
import { getApprovalMode } from "../settings.js";

const execFileAsync = promisify(execFile);

/**
 * M3: run_command — risk-bucketed execution of verification commands (tests,
 * builds, typechecks) and anything else the architect wants to run.
 *
 * Buckets (see safety.ts):
 *   - "safe": provably read-only → runs directly, no approval needed.
 *   - "ask":  dangerous by construction → always requires `approved: true`
 *             (the model must have asked the user first). Never auto-runs.
 *   - "judged": depends on the approval mode:
 *         normal → requires `approved: true` (user said yes in chat).
 *         auto   → the model judges it safe and passes `approved: true` on its
 *                  own judgment; if it judges it risky, it must ask the user.
 *
 * No shell is used — the executable and args are passed to execFile as-is, so
 * shell metacharacters have no meaning.
 */

export const runCommandInputSchema = projectSessionInputSchema.extend({
  command: z.string().describe("Executable to run, e.g. \"npm\"."),
  args: z.array(z.string()).optional().describe("Arguments, e.g. [\"test\"]."),
  timeout_sec: z.number().int().min(1).max(600).optional().describe("Timeout in seconds for commands (default 120)."),
  approved: z.boolean().optional().describe("True after the approval required by the current mode."),
  redact_secrets: z.boolean().optional().describe("Redact known secret patterns from the output (default true)."),
});
export type RunCommandArgs = z.infer<typeof runCommandInputSchema>;

const DEFAULT_TIMEOUT_SEC = 120;

export interface RunCommandResult {
  text: string;
  risk: CommandRisk;
  /** Whether the command ran and exited successfully. */
  ok: boolean;
  /** True when the command was refused pending approval. */
  needsApproval: boolean;
}

export async function runCommand(args: RunCommandArgs): Promise<RunCommandResult> {
  const root = resolveProjectDir(args.project, args.session_token);
  const argv = args.args ?? [];
  const full = [args.command, ...argv].join(" ");
  const bucket = bucketCommand(args.command, argv);
  const risk = classifyCommand(full);
  const timeoutSec = Math.min(args.timeout_sec ?? DEFAULT_TIMEOUT_SEC, 600);

  if (bucket !== "safe" && args.approved !== true) {
    const mode = getApprovalMode();
    const instruction =
      bucket === "ask"
        ? `\`${full}\` is classified as ${risk} — a dangerous command. Ask the user: "May I run: ${full}?" ` +
          `and retry with approved: true only after they say yes. Never run it without explicit user approval.`
        : mode === "auto"
          ? `You are in AUTO mode: judge for yourself whether \`${full}\` is safe. ` +
            `If it is safe, retry with approved: true. If it is risky or unclear, ask the user instead.`
          : `You are in NORMAL mode: ask the user "May I run: ${full}?" and retry with approved: true only after they say yes.`;
    return {
      text: `Refused to run \`${full}\` without approval.\n\n${instruction}`,
      risk,
      ok: false,
      needsApproval: true,
    };
  }

  try {
    const { stdout, stderr } = await execFileAsync(args.command, argv, {
      cwd: root,
      timeout: timeoutSec * 1000,
      maxBuffer: 20 * 1024 * 1024,
      env: { ...process.env } as Record<string, string>,
    });
    const combined = [stdout, stderr].filter(Boolean).join("\n").trim();
    const shown = combined === "" ? "(no output)" : truncateText(combined, 30_000);
    const text = `$ ${full}  (exit 0, ${root})\n\n${shown}`;
    return { text: (args.redact_secrets ?? true) ? redactSecrets(text) : text, risk, ok: true, needsApproval: false };
  } catch (e) {
    const err = e as { code?: number | string; killed?: boolean; stdout?: string; stderr?: string; message?: string };
    const code = err.code !== undefined ? ` (exit code ${err.code}${err.killed ? ", killed by timeout" : ""})` : "";
    const out = [err.stdout, err.stderr].filter(Boolean).join("\n").trim();
    const detail = out || err.message || String(e);
    const text = `$ ${full}${code} in ${root}\n\n${truncateText(detail, 30_000)}`;
    return {
      text: (args.redact_secrets ?? true) ? redactSecrets(text) : text,
      risk,
      ok: false,
      needsApproval: false,
    };
  }
}
