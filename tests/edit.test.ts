import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { editFile, editPack, writeFile } from "../src/tools/edit.js";
import { baseArgs, makeFixture, touchFile } from "./helpers.js";

test("write_file: creates a new file", () => {
  const f = makeFixture();
  try {
    const out = writeFile({ ...baseArgs(f), path: "notes/hello.txt", content: "hello world\n" });
    assert.ok(out.includes("Created notes/hello.txt"));
    assert.equal(readFileSync(path.join(f.root, "notes", "hello.txt"), "utf8"), "hello world\n");
  } finally {
    f.cleanup();
  }
});

test("write_file: refuses to overwrite an existing file", () => {
  const f = makeFixture();
  try {
    assert.throws(
      () => writeFile({ ...baseArgs(f), path: "README.md", content: "nope" }),
      /already exists.*edit_file/,
    );
    assert.equal(readFileSync(path.join(f.root, "README.md"), "utf8").startsWith("# Fixture"), true);
  } finally {
    f.cleanup();
  }
});

test("write_file: refuses paths outside the approved project", () => {
  const f = makeFixture();
  try {
    assert.throws(
      () => writeFile({ ...baseArgs(f), path: path.join(f.outside, "secret.txt"), content: "x" }),
      /outside the approved project/,
    );
    assert.ok(!existsSync(path.join(f.outside, "secret2.txt")));
  } finally {
    f.cleanup();
  }
});

test("edit_file: replaces an exact match", () => {
  const f = makeFixture();
  try {
    const out = editFile({
      ...baseArgs(f),
      path: "src/index.ts",
      search: 'const greeting = "hello";',
      replace: 'const greeting = "hi";',
    });
    assert.ok(out.includes("1 occurrence(s) replaced"));
    const after = readFileSync(path.join(f.root, "src", "index.ts"), "utf8");
    assert.ok(after.includes('const greeting = "hi";'));
    assert.ok(!after.includes('"hello"'));
  } finally {
    f.cleanup();
  }
});

test("edit_file: stale or ambiguous matches write nothing", () => {
  const f = makeFixture();
  try {
    const before = readFileSync(path.join(f.root, "src", "index.ts"), "utf8");
    // Stale: search text not in the file.
    assert.throws(
      () => editFile({ ...baseArgs(f), path: "src/index.ts", search: "not in the file", replace: "x" }),
      /could not find/,
    );
    // Ambiguous: appears more than once without replace_all.
    touchFile(f, "src/dup.ts", "same same\n");
    assert.throws(
      () => editFile({ ...baseArgs(f), path: "src/dup.ts", search: "same", replace: "diff" }),
      /appears 2 times/,
    );
    assert.equal(readFileSync(path.join(f.root, "src", "index.ts"), "utf8"), before);
    assert.equal(readFileSync(path.join(f.root, "src", "dup.ts"), "utf8"), "same same\n");

    // replace_all replaces every occurrence.
    const out = editFile({ ...baseArgs(f), path: "src/dup.ts", search: "same", replace: "diff", replace_all: true });
    assert.ok(out.includes("2 occurrence(s) replaced"));
    assert.equal(readFileSync(path.join(f.root, "src", "dup.ts"), "utf8"), "diff diff\n");
  } finally {
    f.cleanup();
  }
});

test("edit_file: refuses binary files", () => {
  const f = makeFixture();
  try {
    assert.throws(
      () => editFile({ ...baseArgs(f), path: "assets/blob.bin", search: "x", replace: "y" }),
      /binary/,
    );
  } finally {
    f.cleanup();
  }
});

test("edit_pack: applies a batch of edits and writes together", () => {
  const f = makeFixture();
  try {
    touchFile(f, "src/a.ts", "const A = 1;\n");
    touchFile(f, "src/b.ts", "const B = 2;\n");
    const out = editPack({
      ...baseArgs(f),
      edits: [
        { path: "src/a.ts", search: "const A = 1;", replace: "const A = 10;" },
        { path: "src/b.ts", search: "const B = 2;", replace: "const B = 20;" },
      ],
      writes: [{ path: "src/c.ts", content: "const C = 30;\n" }],
    });
    assert.ok(out.includes("3 file(s) changed"));
    assert.equal(readFileSync(path.join(f.root, "src", "a.ts"), "utf8"), "const A = 10;\n");
    assert.equal(readFileSync(path.join(f.root, "src", "b.ts"), "utf8"), "const B = 20;\n");
    assert.equal(readFileSync(path.join(f.root, "src", "c.ts"), "utf8"), "const C = 30;\n");
  } finally {
    f.cleanup();
  }
});

test("edit_pack: a validation failure writes nothing", () => {
  const f = makeFixture();
  try {
    touchFile(f, "src/a.ts", "const A = 1;\n");
    const before = readFileSync(path.join(f.root, "src", "a.ts"), "utf8");
    assert.throws(
      () =>
        editPack({
          ...baseArgs(f),
          edits: [
            { path: "src/a.ts", search: "const A = 1;", replace: "const A = 10;" },
            { path: "src/a.ts", search: "not present", replace: "x" },
          ],
          writes: [{ path: "src/c.ts", content: "const C = 30;\n" }],
        }),
      /could not find the search text/,
    );
    assert.equal(readFileSync(path.join(f.root, "src", "a.ts"), "utf8"), before);
    assert.ok(!existsSync(path.join(f.root, "src", "c.ts")));
  } finally {
    f.cleanup();
  }
});

test("edit_pack: same-file edits chain in order", () => {
  const f = makeFixture();
  try {
    touchFile(f, "src/a.ts", "one two three\n");
    editPack({
      ...baseArgs(f),
      edits: [
        { path: "src/a.ts", search: "one", replace: "1" },
        { path: "src/a.ts", search: "two", replace: "2" },
      ],
    });
    assert.equal(readFileSync(path.join(f.root, "src", "a.ts"), "utf8"), "1 2 three\n");
  } finally {
    f.cleanup();
  }
});

test("edit_pack: refuses edit+create on the same path and empty packs", () => {
  const f = makeFixture();
  try {
    touchFile(f, "src/a.ts", "one\n");
    assert.throws(
      () =>
        editPack({
          ...baseArgs(f),
          edits: [{ path: "src/a.ts", search: "one", replace: "1" }],
          writes: [{ path: "src/a.ts", content: "x" }],
        }),
      /cannot both edit and create/,
    );
    assert.throws(() => editPack({ ...baseArgs(f) }), /needs at least one/);
    assert.throws(
      () => editPack({ ...baseArgs(f), writes: [{ path: "src/util.ts", content: "x" }] }),
      /already exists/,
    );
  } finally {
    f.cleanup();
  }
});
