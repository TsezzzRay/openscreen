import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  memoryWorkspaceDiff,
  prepareMemoryWorkspace,
  resetMemoryWorkspaceBaseline,
  syncConsolidationInputs,
} from "../../src/harness/memory/consolidate/workspace.js";
import type { ConsolidationInput } from "../../src/harness/memory/consolidate/repository.js";

const inputs: ConsolidationInput[] = [
  {
    jobKey: "chronicle:window:2026-08-04T10:00:00.000Z",
    sourceKind: "chronicle",
    sourceId: "observation-window:2026-08-04T10:00:00.000Z",
    sourceGeneration: 1,
    sourceUpdatedAt: 1,
    sourceSummary: "The user reviewed an OpenScreen memory design in Safari.",
    rawMemory: null,
    scopeHints: [{ type: "topic", key: "openscreen-memory", label: "OpenScreen Memory" }],
    generatedAt: Date.parse("2026-08-04T10:01:20.000Z"),
    artifactPath: "rollout_summaries/chronicle-memory-design.md",
    contentHash: "a".repeat(64),
    startedAt: Date.parse("2026-08-04T10:00:00.000Z"),
    endedAt: Date.parse("2026-08-04T10:01:00.000Z"),
    provenance: "passive_screen",
    sourceIds: ["observation:1"],
    state: "added",
  },
  {
    jobKey: "turn-memory:batch:session-1:turn-1",
    sourceKind: "turn_memory",
    sourceId: "turn-batch:session-1:turn-1",
    sourceGeneration: 1,
    sourceUpdatedAt: 2,
    sourceSummary: "The user explicitly chose a six-hour consolidation cooldown.",
    rawMemory: "The user chose a six-hour consolidation cooldown.",
    scopeHints: [{ type: "workflow", key: "memory-consolidation" }],
    generatedAt: Date.parse("2026-08-04T11:01:20.000Z"),
    artifactPath: "rollout_summaries/turn-consolidation-cooldown.md",
    contentHash: "b".repeat(64),
    startedAt: Date.parse("2026-08-04T10:30:00.000Z"),
    endedAt: Date.parse("2026-08-04T11:00:00.000Z"),
    provenance: "user_turn",
    sourceIds: ["turn:1"],
    state: "added",
  },
];
const execFileAsync = promisify(execFile);

test("syncs structured Memory sources into one Codex-style Markdown workspace", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-memory-workspace-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await prepareMemoryWorkspace(root);

  const synced = await syncConsolidationInputs(root, inputs);

  assert.equal(synced.sourceSummaryFiles.length, 2);
  assert.deepEqual(synced.sourceSummaryFiles, [
    "rollout_summaries/chronicle-memory-design.md",
    "rollout_summaries/turn-consolidation-cooldown.md",
  ]);
  const raw = await readFile(join(root, "raw_memories.md"), "utf8");
  assert.doesNotMatch(raw, /OpenScreen memory pipeline/);
  assert.match(raw, /six-hour consolidation cooldown/);
  assert.match(raw, /turn-memory:batch:session-1:turn-1/);
  for (const relative of synced.sourceSummaryFiles) {
    assert.equal((await stat(join(root, relative))).mode & 0o777, 0o600);
  }
  await assert.rejects(access(join(root, "projects")));
  await assert.rejects(access(join(root, "workdirs")));
});

test("uses a disposable one-commit Git baseline to detect real workspace changes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-memory-workspace-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await prepareMemoryWorkspace(root);
  const firstBaseline = (await execFileAsync("git", ["rev-parse", "HEAD"], {
    cwd: root,
  })).stdout.trim();
  await syncConsolidationInputs(root, inputs);

  const changed = await memoryWorkspaceDiff(root);
  assert.equal(changed.hasChanges, true);
  assert.match(changed.diff, /raw_memories\.md/);
  assert.match(changed.diff, /six-hour consolidation cooldown/);

  await resetMemoryWorkspaceBaseline(root);
  assert.equal((await memoryWorkspaceDiff(root)).hasChanges, false);
  assert.equal(Number((await execFileAsync("git", [
    "rev-list", "--count", "HEAD",
  ], { cwd: root })).stdout.trim()), 1);
  await assert.rejects(execFileAsync("git", [
    "cat-file", "-e", `${firstBaseline}^{commit}`,
  ], { cwd: root }));

  await syncConsolidationInputs(root, [{
    ...inputs[0]!,
    sourceGeneration: 2,
    sourceUpdatedAt: 3,
    sourceSummary: "The user revised the OpenScreen memory design.",
  }]);
  const revised = await memoryWorkspaceDiff(root);
  assert.equal(revised.hasChanges, true);
  assert.match(revised.diff, /revised the OpenScreen memory design/);
  assert.match(revised.diff, /deleted file mode|six-hour consolidation cooldown/);
});

test("keeps SQLite and evidence outside the Git baseline", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-memory-workspace-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await prepareMemoryWorkspace(root);
  const ignore = await readFile(join(root, ".gitignore"), "utf8");

  assert.match(ignore, /memory\.sqlite3/);
  assert.match(ignore, /evidence/);
  assert.match(ignore, /\.consolidation-staging/);
  assert.match(ignore, /\.DS_Store/);
  await writeFile(join(root, ".DS_Store"), "finder metadata");
  await mkdir(join(root, "rollout_summaries"), { recursive: true });
  await writeFile(
    join(root, "rollout_summaries", ".DS_Store"),
    "finder metadata",
  );
  await resetMemoryWorkspaceBaseline(root);
  assert.doesNotMatch((await execFileAsync("git", ["ls-files"], {
    cwd: root,
  })).stdout, /\.DS_Store/);
});

test("does not adopt or modify a user-owned Git repository", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-foreign-repository-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await execFileAsync("git", ["init", "--quiet"], { cwd: root });
  await writeFile(join(root, "user.txt"), "keep me\n");
  await execFileAsync("git", ["add", "user.txt"], { cwd: root });
  await execFileAsync("git", [
    "-c", "user.name=User",
    "-c", "user.email=user@example.com",
    "commit", "--quiet", "-m", "user commit",
  ], { cwd: root });

  await assert.rejects(prepareMemoryWorkspace(root), /dedicated|owned|repository/i);
  assert.equal(await readFile(join(root, "user.txt"), "utf8"), "keep me\n");
  assert.equal((await execFileAsync("git", ["rev-list", "--count", "HEAD"], {
    cwd: root,
  })).stdout.trim(), "1");
});

test("creates a dedicated nested baseline without touching an enclosing repository", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "openscreen-enclosing-repository-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  await execFileAsync("git", ["init", "--quiet"], { cwd: parent });
  await writeFile(join(parent, "user.txt"), "outer work\n");
  await execFileAsync("git", ["add", "user.txt"], { cwd: parent });
  await execFileAsync("git", [
    "-c", "user.name=User",
    "-c", "user.email=user@example.com",
    "commit", "--quiet", "-m", "outer commit",
  ], { cwd: parent });
  const root = join(parent, "data", "memory");
  await mkdir(root, { recursive: true });

  await prepareMemoryWorkspace(root);
  await syncConsolidationInputs(root, inputs);
  await resetMemoryWorkspaceBaseline(root);

  assert.equal(await readFile(join(parent, "user.txt"), "utf8"), "outer work\n");
  assert.equal((await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
    cwd: root,
  })).stdout.trim(), await realpath(root));
});

test("returns the complete workspace diff without silent truncation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-memory-workspace-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await prepareMemoryWorkspace(root);
  await resetMemoryWorkspaceBaseline(root);
  const marker = "END-OF-LARGE-DIFF";
  await writeFile(join(root, "large.md"), `${"x".repeat(300 * 1024)}${marker}\n`);

  const changed = await memoryWorkspaceDiff(root);

  assert.equal(changed.hasChanges, true);
  assert.match(changed.diff, new RegExp(marker));
  assert.doesNotMatch(changed.diff, /diff truncated/);
});
