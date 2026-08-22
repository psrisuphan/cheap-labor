import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

import { projectSessionInputSchema, resolveInsideRoot, resolveProjectDir, truncateText } from "../safety.js";

/**
 * M4: direct write tools — ChatGPT edits small things itself for free (zero
 * Codex usage). Codex `implement` stays for the heavy, multi-step work.
 *
 * Safety model:
 * - Session-approved project required (project + session_token), paths
 *   resolved inside the approved project directory.
 * - `write_file` only CREATES files: it refuses to overwrite an existing one
 *   (use edit_file for changes).
 * - `edit_file` modifies an existing file via exact-match replacement; if the
 *   match isn't found exactly, it errors — the content-based stale guard.
 * - `edit_pack` validates every guard before applying a batch. Validation
 *   failures write nothing; filesystem failures during application can leave
 *   earlier files changed.
 * - Binary files refused; size caps on read and write.
 */

const MAX_WRITE_BYTES = 1_000_000;
const MAX_READ_BYTES = 5_000_000;
const MAX_PACK_ITEMS = 20;

export const writeFileInputSchema = projectSessionInputSchema.extend({
  path: z.string().describe("Path to the new file, relative to the project or absolute inside it."),
  content: z.string().describe("Full file contents."),
});
export type WriteFileArgs = z.infer<typeof writeFileInputSchema>;

export const editFileInputSchema = projectSessionInputSchema.extend({
  path: z.string().describe("Path to the existing file, relative to the project or absolute inside it."),
  search: z.string().min(1).describe("Exact text to find in the current file."),
  replace: z.string().describe("Replacement text."),
  replace_all: z.boolean().optional().describe("Replace all occurrences (default false)."),
});
export type EditFileArgs = z.infer<typeof editFileInputSchema>;

const packEditSchema = z.object({
  path: z.string().describe("File to edit."),
  search: z.string().min(1).describe("Exact text to find in the current file."),
  replace: z.string().describe("Replacement text."),
  replace_all: z.boolean().optional().describe("Replace all occurrences (default false)."),
});

const packWriteSchema = z.object({
  path: z.string().describe("Path to the new file."),
  content: z.string().describe("Full file contents."),
});

export const editPackInputSchema = projectSessionInputSchema.extend({
  edits: z.array(packEditSchema).max(MAX_PACK_ITEMS).optional().describe("Existing-file edits, applied in order."),
  writes: z.array(packWriteSchema).max(MAX_PACK_ITEMS).optional().describe("New files to create."),
});
export type EditPackArgs = z.infer<typeof editPackInputSchema>;

function readTextFile(abs: string, rel: string): string {
  const stat = statSync(abs);
  if (!stat.isFile()) {
    throw new Error(`"${rel}" is not a file.`);
  }
  if (stat.size > MAX_READ_BYTES) {
    throw new Error(`"${rel}" is too large to edit directly (${stat.size} bytes) — delegate it to Codex.`);
  }
  const buf = readFileSync(abs);
  if (buf.includes(0)) {
    throw new Error(`"${rel}" appears to be a binary file — refusing to edit it directly.`);
  }
  return buf.toString("utf8");
}

/** Pure validation + computation of one exact-match edit. No writes. */
function prepareEdit(
  current: string,
  rel: string,
  search: string,
  replace: string,
  replaceAll: boolean,
): { updated: string; count: number } {
  if (search.length === 0) throw new Error(`(${rel}) search must not be empty.`);
  const count = current.split(search).length - 1;
  if (count === 0) {
    throw new Error(
      `(${rel}) could not find the search text — the file may have changed. ` +
        `Re-read it and retry. Nothing in this pack was written.`,
    );
  }
  if (!replaceAll && count > 1) {
    throw new Error(
      `(${rel}) the search text appears ${count} times. Narrow it to one occurrence, ` +
        `or set replace_all: true. Nothing in this pack was written.`,
    );
  }
  const updated = replaceAll
    ? current.split(search).join(replace)
    : current.replace(search, replace);
  if (Buffer.byteLength(updated, "utf8") > MAX_WRITE_BYTES) {
    throw new Error(`(${rel}) resulting file would exceed the direct-edit size cap — delegate to Codex.`);
  }
  return { updated, count: replaceAll ? count : 1 };
}

/** Show the changed region around the first occurrence of `needle`. */
function changedSnippet(text: string, needle: string): string {
  const idx = text.indexOf(needle);
  const start = Math.max(0, text.lastIndexOf("\n", Math.max(0, idx - 120)) + 1);
  const endIdx = idx >= 0 ? idx + needle.length : 0;
  const end = Math.min(text.length, endIdx + 200);
  return truncateText(text.slice(start, end), 1200);
}

/**
 * Create a new file (creating parent directories inside the approved project
 * as needed). Refuses to overwrite an existing file — existing files are
 * changed with edit_file so every modification is an explicit,
 * content-checked operation.
 */
export function writeFile(args: WriteFileArgs): string {
  const root = resolveProjectDir(args.project, args.session_token);
  const { abs } = resolveInsideRoot(args.path, root);
  const rel = path.relative(root, abs);

  if (Buffer.byteLength(args.content, "utf8") > MAX_WRITE_BYTES) {
    throw new Error(`Refusing to write ${Buffer.byteLength(args.content, "utf8")} bytes — delegate large files to Codex.`);
  }

  let exists = false;
  try {
    exists = statSync(abs).isFile();
  } catch {
    /* does not exist — good */
  }
  if (exists) {
    throw new Error(
      `"${rel}" already exists — use edit_file to change existing files, ` +
        `or ask the user how to proceed. Nothing was written.`,
    );
  }

  // Parents are created only under the approved project (path already verified).
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, args.content, "utf8");
  return (
    `Created ${rel} (${Buffer.byteLength(args.content, "utf8")} bytes).\n\n` +
    "```\n" + truncateText(args.content, 4000) + "\n```"
  );
}

/**
 * Modify an existing file by exact-match replacement. The content-based stale
 * guard: if `search` doesn't appear in the file (or appears more than once
 * while replace_all is false), nothing is written — re-read the file and try
 * again. Returns the changed region for the review loop.
 */
export function editFile(args: EditFileArgs): string {
  const root = resolveProjectDir(args.project, args.session_token);
  const { abs } = resolveInsideRoot(args.path, root);
  const rel = path.relative(root, abs);

  const original = readTextFile(abs, rel);
  const { updated, count } = prepareEdit(original, rel, args.search, args.replace, args.replace_all ?? false);

  writeFileSync(abs, updated, "utf8");
  const snippet = changedSnippet(updated, args.replace);
  return (
    `Edited ${rel} — ${count} occurrence(s) replaced.\n\n` +
    "```\n" + snippet + "\n```\n\n" +
    `(review with git_diff; targeted correction: re-read the file, then edit_file again)`
  );
}

/**
 * Batch several edits/writes after validating every guard against current
 * on-disk content. Same-file edits chain in memory, and each file is written
 * once with its final content.
 */
export function editPack(args: EditPackArgs): string {
  const root = resolveProjectDir(args.project, args.session_token);
  const edits = args.edits ?? [];
  const writes = args.writes ?? [];

  if (edits.length + writes.length === 0) {
    throw new Error("edit_pack needs at least one edit or write.");
  }
  if (edits.length + writes.length > MAX_PACK_ITEMS) {
    throw new Error(`Too many items in one pack (max ${MAX_PACK_ITEMS}) — split it into smaller packs.`);
  }

  // Phase 1 — validate everything, write nothing.
  const contents = new Map<string, string>(); // abs -> final content
  const receipt: string[] = [];

  for (const e of edits) {
    const { abs } = resolveInsideRoot(e.path, root);
    const rel = path.relative(root, abs);
    if (writes.some((w) => path.resolve(root, w.path) === abs)) {
      throw new Error(`(${rel}) a pack cannot both edit and create the same file.`);
    }
    let current = contents.get(abs);
    if (current === undefined) {
      current = readTextFile(abs, rel);
      contents.set(abs, current);
    }
    const { updated, count } = prepareEdit(current, rel, e.search, e.replace, e.replace_all ?? false);
    contents.set(abs, updated);
    receipt.push(`edited ${rel} (${count} occurrence(s) replaced)`);
  }

  for (const w of writes) {
    const { abs } = resolveInsideRoot(w.path, root);
    const rel = path.relative(root, abs);
    if (contents.has(abs)) {
      throw new Error(`(${rel}) a pack cannot both edit and create the same file.`);
    }
    if (Buffer.byteLength(w.content, "utf8") > MAX_WRITE_BYTES) {
      throw new Error(`(${rel}) content exceeds the direct-write size cap — delegate to Codex.`);
    }
    let exists = false;
    try {
      exists = statSync(abs).isFile();
    } catch {
      /* good */
    }
    if (exists) {
      throw new Error(`(${rel}) already exists — use an edit for existing files.`);
    }
    contents.set(abs, w.content);
    receipt.push(`created ${rel} (${Buffer.byteLength(w.content, "utf8")} bytes)`);
  }

  // Phase 2 — apply.
  for (const [abs, content] of contents) {
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
  }

  return (
    `edit_pack applied — ${contents.size} file(s) changed after validation:\n\n` +
    receipt.map((r) => `- ${r}`).join("\n") +
    `\n\n(review with git_diff)`
  );
}
