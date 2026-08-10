import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createFindTool } from "../../src/tools/system/find.js";
import { createGrepTool } from "../../src/tools/system/grep.js";
import { createLsTool } from "../../src/tools/system/ls.js";
import { createReadTool } from "../../src/tools/system/read.js";

const signal = new AbortController().signal;

test("read uses 1-indexed offsets and emits an actionable continuation notice", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openscreen-read-"));
  const path = join(directory, "large.txt");
  await writeFile(path, Array.from({ length: 2_002 }, (_, index) => `line-${index + 1}`).join("\n"));
  const read = createReadTool(directory);

  const first = await read.execute({ path }, signal) as any;
  assert.match(first.content, /^line-1\nline-2/);
  assert.match(first.content, /\[Showing lines 1-2000 of 2002\. Use offset=2001 to continue\.\]$/);
  assert.equal(first.details.truncation.truncatedBy, "lines");

  const continued = await read.execute({ path, offset: 2_001, limit: 1 }, signal) as any;
  assert.equal(
    continued.content,
    "line-2001\n\n[1 more lines in file. Use offset=2002 to continue.]",
  );
});

test("read validates its arguments before accessing the filesystem", async () => {
  const read = createReadTool("/");
  await assert.rejects(
    read.execute({ path: "/tmp/file", offset: 0 }, signal),
    /offset must be a positive integer/,
  );
});

test("ls sorts entries, marks directories, and reports its entry limit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openscreen-ls-"));
  await mkdir(join(directory, "Alpha"));
  await writeFile(join(directory, "beta.txt"), "b");
  await writeFile(join(directory, ".hidden"), "h");
  const ls = createLsTool(directory);

  const result = await ls.execute({ path: ".", limit: 2 }, signal) as any;
  assert.equal(result.content, ".hidden\nAlpha/\n\n[2 entries limit reached. Use limit=4 for more]");
  assert.equal(result.details.entryLimitReached, 2);
});

test("ls follows a symlink when marking directory entries", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openscreen-ls-"));
  await mkdir(join(directory, "target"));
  await symlink(join(directory, "target"), join(directory, "alias"));

  const result = await createLsTool(directory).execute({}, signal) as any;
  assert.equal(result.content, "alias/\ntarget/");
});

test("grep caps matches, truncates long lines, and keeps paths relative", async () => {
  const directory = "/workspace";
  const grep = createGrepTool(directory, {
    search: async () => Array.from({ length: 101 }, (_, index) => ({
      filePath: join(directory, "src", "file.ts"),
      lineNumber: index + 1,
      lineText: index === 0 ? "x".repeat(510) : `match-${index + 1}`,
    })),
  });

  const result = await grep.execute({ pattern: "match" }, signal) as any;
  assert.match(result.content, /^src\/file\.ts:1: x{500}\.\.\. \[truncated\]/);
  assert.match(result.content, /100 matches limit reached/);
  assert.match(result.content, /Some lines truncated to 500 chars/);
  assert.equal(result.details.matchLimitReached, 100);
  assert.equal(result.details.linesTruncated, true);
});

test("find caps relative glob results at 1000 and reports continuation guidance", async () => {
  const directory = "/workspace";
  const find = createFindTool(directory, {
    search: async () => Array.from(
      { length: 1_001 },
      (_, index) => join(directory, "src", `${String(index).padStart(4, "0")}.ts`),
    ),
  });

  const result = await find.execute({ pattern: "**/*.ts" }, signal) as any;
  assert.match(result.content, /^src\/0000\.ts\nsrc\/0001\.ts/);
  assert.match(result.content, /\[1000 results limit reached\. Use limit=2000 for more, or refine pattern\]$/);
  assert.equal(result.details.resultLimitReached, 1_000);
});

test("packaged ripgrep powers default grep and find while respecting ignores", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openscreen-rg-"));
  await mkdir(join(directory, "src"));
  await mkdir(join(directory, ".git"));
  await mkdir(join(directory, "node_modules"));
  await writeFile(join(directory, ".gitignore"), "ignored.ts\nnode_modules/\n");
  await writeFile(join(directory, "src", "visible.ts"), "const marker = 'visible';\n");
  await writeFile(join(directory, "ignored.ts"), "const marker = 'ignored';\n");
  await writeFile(join(directory, "node_modules", "vendor.ts"), "const marker = 'vendor';\n");

  const grep = await createGrepTool(directory).execute({ pattern: "marker" }, signal) as any;
  assert.match(grep.content, /^src\/visible\.ts:1:/);
  assert.doesNotMatch(grep.content, /ignored|vendor/);

  const find = await createFindTool(directory).execute({ pattern: "*.ts" }, signal) as any;
  assert.equal(find.content, "src/visible.ts");
});

test("default find reports an empty directory as no matches", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openscreen-find-empty-"));
  const result = await createFindTool(directory).execute({ pattern: "*.ts" }, signal) as any;
  assert.equal(result.content, "No files found matching pattern");
});
