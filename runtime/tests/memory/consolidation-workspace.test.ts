import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  memoryWorkspaceDiff,
  memoryWorkspaceHead,
  prepareMemoryWorkspace,
  publishMemoryWorkspaceBaseline,
  rollbackMemoryWorkspace,
} from "../../src/memory/consolidate/workspace.js";

const execFileAsync = promisify(execFile);

async function git(root: string, args: string[]): Promise<string> {
  return (await execFileAsync("git", args, { cwd: root, encoding: "utf8" }))
    .stdout.trim();
}

test("prepares one private OpenScreen-owned Git workspace without remotes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-memory-git-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "memory.sqlite3"), "private sqlite data");
  await mkdir(join(root, "evidence"));
  await mkdir(join(root, "screenpipe"));

  await prepareMemoryWorkspace(root);

  assert.equal(await git(root, ["rev-parse", "--show-toplevel"]), await realpath(root));
  assert.equal(
    await realpath(await git(root, ["rev-parse", "--absolute-git-dir"])),
    join(await realpath(root), ".git"),
  );
  assert.equal(await git(root, ["config", "--local", "--get", "openscreen.memoryRoot"]), "true");
  assert.equal(await git(root, ["remote"]), "");
  assert.equal(
    await readFile(join(root, ".openscreen-memory-root"), "utf8"),
    "openscreen-memory-root-v1\n",
  );
  assert.deepEqual((await git(root, ["ls-files"])).split("\n"), [
    ".gitignore",
    ".openscreen-memory-root",
  ]);
  const ignore = await readFile(join(root, ".gitignore"), "utf8");
  assert.match(ignore, /memory\.sqlite3/);
  assert.match(ignore, /evidence\//);
  assert.match(ignore, /screenpipe\//);
  assert.match(ignore, /\.consolidation-staging\//);
});

test("keeps producer artifacts dirty and returns their complete diff", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-memory-git-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await prepareMemoryWorkspace(root);
  await mkdir(join(root, "rollout_summaries"));
  const marker = "END-OF-COMPLETE-MEMORY-DIFF";
  await writeFile(
    join(root, "rollout_summaries", "turn-example.md"),
    `${"x".repeat(300 * 1024)}${marker}\n`,
  );
  await writeFile(join(root, "raw_memories.md"), "# Raw Memories\n");

  const changed = await memoryWorkspaceDiff(root);

  assert.equal(changed.hasChanges, true);
  assert.match(changed.diff, /raw_memories\.md/);
  assert.match(changed.diff, new RegExp(marker));
  assert.match(await git(root, ["status", "--porcelain=v1"]), /\?\?/);
});

test("publishes each snapshot as the only parentless Git baseline", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-memory-git-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await prepareMemoryWorkspace(root);
  const initial = await memoryWorkspaceHead(root);
  await writeFile(join(root, "MEMORY.md"), "# Memory\n\nFirst snapshot.\n");
  await writeFile(join(root, "memory_summary.md"), "# Memory Summary\n");

  const published = await publishMemoryWorkspaceBaseline(root, initial);

  assert.notEqual(published, initial);
  assert.equal(await memoryWorkspaceHead(root), published);
  assert.equal((await git(root, ["rev-list", "--parents", "-n", "1", "HEAD"])).split(/\s+/).length, 1);
  assert.equal(await git(root, ["rev-list", "--count", "HEAD"]), "1");
  assert.equal(await git(root, ["status", "--porcelain=v1"]), "");
  await assert.rejects(execFileAsync("git", ["cat-file", "-e", `${initial}^{commit}`], { cwd: root }));

  await writeFile(join(root, "MEMORY.md"), "# Memory\n\nSecond snapshot.\n");
  await assert.rejects(
    publishMemoryWorkspaceBaseline(root, initial),
    /changed|compare-and-swap|CAS/i,
  );
  assert.match(await readFile(join(root, "MEMORY.md"), "utf8"), /Second snapshot/);
  assert.equal((await memoryWorkspaceDiff(root)).hasChanges, true);
});

test("rejects foreign repositories and files outside the Memory manifest", async (t) => {
  const foreign = await mkdtemp(join(tmpdir(), "openscreen-foreign-git-"));
  t.after(() => rm(foreign, { recursive: true, force: true }));
  await execFileAsync("git", ["init", "--quiet"], { cwd: foreign });
  await writeFile(join(foreign, "user.txt"), "keep me\n");

  await assert.rejects(prepareMemoryWorkspace(foreign), /dedicated|owned|repository/i);
  assert.equal(await readFile(join(foreign, "user.txt"), "utf8"), "keep me\n");

  const root = await mkdtemp(join(tmpdir(), "openscreen-memory-git-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await prepareMemoryWorkspace(root);
  await writeFile(join(root, "unowned.txt"), "do not publish\n");
  await assert.rejects(memoryWorkspaceDiff(root), /manifest|path/i);
  await assert.rejects(
    publishMemoryWorkspaceBaseline(root, await memoryWorkspaceHead(root)),
    /manifest|path/i,
  );
  assert.equal(await readFile(join(root, "unowned.txt"), "utf8"), "do not publish\n");
});

test("creates an isolated nested repository without touching its enclosing repository", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "openscreen-enclosing-git-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  await execFileAsync("git", ["init", "--quiet"], { cwd: parent });
  await writeFile(join(parent, "user.txt"), "outer work\n");
  const root = join(parent, "data", "memory");
  await mkdir(root, { recursive: true });

  await prepareMemoryWorkspace(root);

  assert.equal(await git(root, ["rev-parse", "--show-toplevel"]), await realpath(root));
  assert.equal(await readFile(join(parent, "user.txt"), "utf8"), "outer work\n");
  await assert.rejects(access(join(parent, ".openscreen-memory-root")));
});

test("rolls back only tracked and allowed untracked Memory artifacts", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-memory-git-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await prepareMemoryWorkspace(root);
  await writeFile(join(root, "MEMORY.md"), "# dirty memory\n");
  await mkdir(join(root, "rollout_summaries"));
  await writeFile(join(root, "rollout_summaries", "turn-dirty.md"), "dirty\n");
  await writeFile(join(root, "memory.sqlite3"), "ignored private data\n");

  await rollbackMemoryWorkspace(root);

  await assert.rejects(access(join(root, "MEMORY.md")));
  await assert.rejects(access(join(root, "rollout_summaries", "turn-dirty.md")));
  assert.equal(await readFile(join(root, "memory.sqlite3"), "utf8"), "ignored private data\n");
  assert.equal((await memoryWorkspaceDiff(root)).hasChanges, false);
});
