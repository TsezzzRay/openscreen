import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { link, mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SandboxedFileWriter } from "../../src/security/sandboxed-file-writer.js";

test("unapproved write cannot leave the output root", { skip: process.platform !== "darwin" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-file-security-"));
  const output = join(root, "output");
  const outside = join(root, "outside.txt");
  await mkdir(output);
  const writer = new SandboxedFileWriter(output);
  try {
    await writer.write(join(output, "ok.txt"), "allowed");
    assert.equal(await readFile(join(output, "ok.txt"), "utf8"), "allowed");
    await assert.rejects(writer.write(outside, "denied"));
    await assert.rejects(readFile(outside));
    await symlink(root, join(output, "escape"));
    await assert.rejects(writer.write(join(output, "escape", "alias.txt"), "denied"));
    await assert.rejects(readFile(join(root, "alias.txt")));
    await assert.rejects(writer.append(join(output, "escape", "alias.txt"), "denied"));
    await assert.rejects(readFile(join(root, "alias.txt")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("one approved path allows that write but not a changed source", { skip: process.platform !== "darwin" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-file-security-"));
  const output = join(root, "output");
  const target = join(root, "config.txt");
  await mkdir(output);
  const writer = new SandboxedFileWriter(output);
  try {
    const canonicalTarget = join(await realpath(root), "config.txt");
    await writer.write(canonicalTarget, "first", { approvedPath: canonicalTarget });
    assert.equal(await readFile(target, "utf8"), "first");
    await assert.rejects(writer.write(canonicalTarget, "second", { approvedPath: canonicalTarget, expectedContent: "stale" }));
    assert.equal(await readFile(target, "utf8"), "first");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("approved creation cannot replace a file created at the commit boundary", { skip: process.platform !== "darwin" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-file-security-"));
  const canonicalRoot = await realpath(root);
  const target = join(canonicalRoot, "config.txt");
  const stagePath = join(canonicalRoot, ".openscreen-race.tmp");
  try {
    const workerModule = new URL("../../src/security/file-worker.js", import.meta.url).href;
    const code = `const fs = require("node:fs");
      for (const operation of ["rename", "link"]) {
        const original = fs.promises[operation];
        fs.promises[operation] = async (source, destination) => {
          if (destination === process.argv[1]) {
            await fs.promises.writeFile(destination, "other actor", { flag: "wx" });
          }
          return original(source, destination);
        };
      }
      import(process.argv[2]).catch(error => { console.error(error); process.exitCode = 1; });`;
    const child = spawnSync(process.execPath, ["-e", code, target, workerModule], {
      input: JSON.stringify({ path: target, stagePath, content: "approved", expectedAbsent: true, createParents: false }),
      encoding: "utf8",
    });
    assert.equal(child.status, 1, child.stderr);
    assert.equal(await readFile(target, "utf8"), "other actor");
    assert.deepEqual((await readdir(canonicalRoot)).filter(name => name.startsWith(".openscreen-")), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("failed approved replacement preserves the complete original file", { skip: process.platform !== "darwin" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-file-security-"));
  const canonicalRoot = await realpath(root);
  const output = join(canonicalRoot, "output");
  const target = join(canonicalRoot, "config.txt");
  await mkdir(output);
  await writeFile(target, "original");
  try {
    const workerModule = new URL("../../src/security/sandboxed-file-writer.js", import.meta.url).href;
    const code = `import(process.argv[1]).then(async ({ SandboxedFileWriter }) => {
      try {
        await new SandboxedFileWriter(process.argv[3]).write(process.argv[2], "x".repeat(100_000), {
          approvedPath: process.argv[2], expectedContent: "original",
        });
        process.stdout.write("unexpected success");
      } catch {
        process.stdout.write("rejected");
      }
    });`;
    const child = spawnSync("/bin/bash", [
      "-c", 'ulimit -f 1; exec "$1" -e "$2" "$3" "$4" "$5"',
      "--", process.execPath, code, workerModule, target, output,
    ], { cwd: process.cwd(), encoding: "utf8" });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout, "rejected");
    assert.equal(await readFile(target, "utf8"), "original");
    assert.deepEqual((await readdir(canonicalRoot)).filter(name => name.startsWith(".openscreen-")), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("approved replacement preserves existing extended attributes", { skip: process.platform !== "darwin" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-file-security-"));
  const canonicalRoot = await realpath(root);
  const output = join(canonicalRoot, "output");
  const target = join(canonicalRoot, "config.txt");
  await mkdir(output);
  await writeFile(target, "original");
  try {
    const before = spawnSync("/usr/bin/xattr", ["-w", "com.openscreen.test", "metadata", target], { encoding: "utf8" });
    assert.equal(before.status, 0, before.stderr);
    await new SandboxedFileWriter(output).write(target, "replacement", {
      approvedPath: target,
      expectedContent: "original",
    });
    const after = spawnSync("/usr/bin/xattr", ["-p", "com.openscreen.test", target], { encoding: "utf8" });
    assert.equal(after.status, 0, after.stderr);
    assert.equal(after.stdout.trim(), "metadata");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an approved leaf cannot redirect to another file after approval", { skip: process.platform !== "darwin" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-file-security-"));
  const output = join(root, "output");
  const approved = join(root, "approved.txt");
  const moved = join(root, "moved.txt");
  const other = join(root, "other.txt");
  await mkdir(output);
  await writeFile(approved, "same source");
  await writeFile(other, "same source");
  const canonicalApproved = join(await realpath(root), "approved.txt");
  const writer = new SandboxedFileWriter(output);
  try {
    await rename(approved, moved);
    await symlink(other, approved);
    await assert.rejects(writer.write(canonicalApproved, "replacement", {
      approvedPath: canonicalApproved,
      expectedContent: "same source",
    }));
    assert.equal(await readFile(other, "utf8"), "same source");
    assert.equal(await readFile(moved, "utf8"), "same source");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a cancelled large write rejects without creating the target or crashing the runtime", { skip: process.platform !== "darwin" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-file-security-"));
  const output = join(root, "output");
  const target = join(output, "cancelled.txt");
  await mkdir(output);
  const writer = new SandboxedFileWriter(output);
  const controller = new AbortController();
  controller.abort();
  try {
    await assert.rejects(writer.write(target, "x".repeat(8 * 1024 * 1024), { signal: controller.signal }));
    await assert.rejects(readFile(target));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unapproved file write cannot modify an outside file through a hard link", { skip: process.platform !== "darwin" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-file-security-"));
  const output = join(root, "output");
  const outside = join(root, "outside.txt");
  await mkdir(output);
  await writeFile(outside, "original");
  const alias = join(output, "alias.txt");
  await link(outside, alias);
  const writer = new SandboxedFileWriter(output);
  try {
    await assert.rejects(writer.write(alias, "changed"));
    assert.equal(await readFile(outside, "utf8"), "original");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
