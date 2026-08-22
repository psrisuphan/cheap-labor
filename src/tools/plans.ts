import {
  assertPlanFileName,
  planFileNameSchema,
  planDir,
  readPlanFiles,
  writePlanFile,
} from "../planstore.js";
import { projectSessionInputSchema, resolveProjectDir } from "../safety.js";
import { z } from "zod";

/**
 * M3: `.codex-bridge/` plan management — the ChatGPT → Codex handoff channel.
 * ChatGPT writes the plan here with these tools; `implement` picks it up.
 */

export const planReadInputSchema = projectSessionInputSchema.extend({
  file: planFileNameSchema.optional().describe("Which file to read (default: all)."),
});
export type PlanReadArgs = z.infer<typeof planReadInputSchema>;

export function planRead(args: PlanReadArgs): string {
  const root = resolveProjectDir(args.project, args.session_token);
  if (args.file) {
    assertPlanFileName(args.file);
    const all = readPlanFiles(root);
    if (!(args.file in all)) {
      return `${args.file} does not exist yet in ${planDir(root)}/.`;
    }
    return `--- ${args.file} (${planDir(root)}) ---\n${all[args.file]}`;
  }
  const all = readPlanFiles(root);
  if (Object.keys(all).length === 0) {
    return `No plan files yet in ${planDir(root)}/. Use plan_write to create PLAN.md / SPEC.md / TASKS.md.`;
  }
  return Object.entries(all)
    .map(([name, content]) => `--- ${name} ---\n${content}\n--- end ${name} ---`)
    .join("\n\n");
}

export const planWriteInputSchema = projectSessionInputSchema.extend({
  file: planFileNameSchema.describe("Plan file to replace."),
  content: z.string().describe("Full file contents."),
});
export type PlanWriteArgs = z.infer<typeof planWriteInputSchema>;

export function planWrite(args: PlanWriteArgs): string {
  assertPlanFileName(args.file);
  const root = resolveProjectDir(args.project, args.session_token);
  const abs = writePlanFile(root, args.file, args.content);
  const bytes = Buffer.byteLength(args.content, "utf8");
  return `Wrote ${abs} (${bytes} bytes). This is now visible to implement via .codex-bridge/.`;
}

export const taskUpdateInputSchema = projectSessionInputSchema.extend({
  task: z.string().describe("Text identifying the task (substring match)."),
  status: z.enum(["todo", "in-progress", "done", "blocked"]).describe("New status."),
  note: z.string().optional().describe("Optional note appended to the task line."),
});
export type TaskUpdateArgs = z.infer<typeof taskUpdateInputSchema>;

const STATUS_MARKERS: Record<TaskUpdateArgs["status"], string> = {
  todo: "[ ]",
  "in-progress": "[~]",
  done: "[x]",
  blocked: "[!]",
};

/**
 * Update a task in TASKS.md: find the line containing `task` and set its
 * checkbox status. Errors when no line matches — TASKS.md is authored via
 * plan_write (full replacement), so nothing in .codex-bridge/ ever grows
 * through appends.
 */
export function taskUpdate(args: TaskUpdateArgs): string {
  assertPlanFileName("TASKS.md");
  const root = resolveProjectDir(args.project, args.session_token);
  const all = readPlanFiles(root);
  const existing = all["TASKS.md"] ?? "";
  const marker = STATUS_MARKERS[args.status];
  const note = args.note ? ` — ${args.note}` : "";
  const needle = args.task.trim().toLowerCase();

  const lines = existing.split("\n");
  let found = false;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].toLowerCase().includes(needle)) {
      // Rewrite the line as a checkbox bullet, whatever style it used before:
      // "- [ ]", "* task", "1. task", or a bare "task".
      lines[i] = lines[i].replace(
        /^(\s*)(?:[-*]\s+|\d+[.)]\s+|)(?:\[[ x~!]\]\s+|)(.*)$/,
        (_, indent, rest) => `${indent}- ${marker} ${rest}`,
      );
      if (note) lines[i] = lines[i].replace(/\s*—.*$/, "") + note;
      found = true;
      break;
    }
  }
  if (!found) {
    throw new Error(
      `Task "${args.task}" was not found in TASKS.md. ` +
        `Read the file with plan_read and rewrite it (with the new task included) via plan_write.`,
    );
  }
  writePlanFile(root, "TASKS.md", lines.join("\n"));
  return `Updated TASKS.md: "${args.task}" → ${args.status}${note}.`;
}
