import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

/**
 * Per-repo `.codex-bridge/` hidden folder: the ChatGPT → Codex handoff
 * channel (PLAN.md, SPEC.md, TASKS.md). Read helpers here are used by
 * `implement`; the write/manage tools (plan_read, plan_write, task_update)
 * are added in M3 on top of the same store.
 */

const PLAN_DIR_NAME = ".codex-bridge";
export const PLAN_FILES = ["PLAN.md", "SPEC.md", "TASKS.md"] as const;
export const planFileNameSchema = z.enum(PLAN_FILES);
export type PlanFileName = z.infer<typeof planFileNameSchema>;

export function planDir(root: string): string {
  return path.join(root, PLAN_DIR_NAME);
}

/** Create `.codex-bridge/` under root if it doesn't exist. */
function ensurePlanDir(root: string): string {
  const dir = planDir(root);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Validate a plan file name; throws on anything outside the known set. */
export function assertPlanFileName(name: string): asserts name is PlanFileName {
  if (!planFileNameSchema.safeParse(name).success) {
    throw new Error(`Unknown plan file "${name}" — must be one of: ${PLAN_FILES.join(", ")}`);
  }
}

/** Write a plan file, creating `.codex-bridge/` as needed. Replaces content. */
export function writePlanFile(root: string, name: PlanFileName, content: string): string {
  const dir = ensurePlanDir(root);
  const abs = path.join(dir, name);
  writeFileSync(abs, content, "utf8");
  return abs;
}

/** Read all existing plan files for a root. Returns a map filename → content. */
export function readPlanFiles(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of PLAN_FILES) {
    const p = path.join(planDir(root), name);
    try {
      if (existsSync(p)) out[name] = readFileSync(p, "utf8");
    } catch {
      // unreadable file — skip it
    }
  }
  return out;
}

/** Render the plan files as a single prompt block for Codex. */
export function renderPlanBlock(plan: Record<string, string>): string {
  const entries = Object.entries(plan);
  if (entries.length === 0) return "";
  return (
    "\n\n=== PLAN FILES (from .codex-bridge/, written by the architect) ===\n" +
    entries
      .map(
        ([name, content]) =>
          `--- ${name} ---\n${content}\n--- end ${name} ---`,
      )
      .join("\n\n")
  );
}
