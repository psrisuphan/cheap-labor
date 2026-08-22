import { ApprovalDecision, ElicitationInfo } from "./tools/codex.js";
import { bucketCommand, splitCommandLine } from "./safety.js";
import { ApprovalMode, getApprovalMode } from "./settings.js";

/**
 * Default approval policy for Codex sessions: answers Codex's shell-approval
 * elicitations using the same three buckets as run_command.
 *
 *   - "safe":   auto-approved (provably read-only).
 *   - "ask":    always denied — recorded and relayed to the user for a veto
 *               (file deletes, git rewrites, network, interpreter one-liners).
 *   - "judged": normal mode → denied (user veto); auto mode → approved on the
 *               model's judgment.
 *
 * The mode is read from settings on every call, so a mid-session change takes
 * effect immediately.
 */

/** Pull the command out of a codex approval message, if it looks like one. */
function extractCommandFromMessage(message: string): string | undefined {
  const trimmed = message.trim();
  if (trimmed.length === 0) return undefined;
  // Codex usually includes the command verbatim in backticks. Prefer the
  // longest backtick run when present.
  const backtick = trimmed.match(/`([^`]+)`/);
  if (backtick) return backtick[1];
  // Otherwise the message itself must look like a command: lowercase
  // executable, then plain args, no sentence punctuation. Prose like
  // "May I proceed?" must NOT be treated as a command.
  const stripped = trimmed.replace(/^run\s+/i, "").replace(/[.?]\s*$/, "");
  if (!/^[a-z0-9][a-z0-9_./-]*(\s+\S[^?]*)?$/.test(stripped)) return undefined;
  if (stripped.length > 200) return undefined;
  return stripped;
}

// Codex's exec/patch approval elicitations carry an empty requested schema and
// parse the response content as a flat ExecApprovalResponse { decision } (the
// Rust enum serializes to snake_case: "approved" | "approved_for_session" |
// "denied"). Verified against codex-cli 0.147.0.

const APPROVED: ApprovalDecision = { action: "accept", content: { decision: "approved" } };
const DENIED: ApprovalDecision = { action: "decline", content: { decision: "denied" } };

export function autoSafeApprovalPolicy(
  info: ElicitationInfo,
  mode: ApprovalMode = getApprovalMode(),
): ApprovalDecision {
  if (info.mode === "url") {
    // Never auto-open URLs; surface them for a human decision.
    return DENIED;
  }
  const cmd = extractCommandFromMessage(info.message);
  if (!cmd) return DENIED;
  const { command, args } = splitCommandLine(cmd);
  if (!command) return DENIED;

  const bucket = bucketCommand(command, args);
  if (bucket === "safe") return APPROVED;
  if (bucket === "judged") return mode === "auto" ? APPROVED : DENIED;
  return DENIED; // "ask" — always needs a human, even in auto mode
}
