import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createMemoryReadPath, loadMemoryPromptContext } from "../../../src/memory/mastra/read-path.js";

test("createMemoryReadPath returns undefined when Memory is disabled", () => {
  assert.equal(createMemoryReadPath("/tmp/memory", { enabled: false }), undefined);
});

test("loadMemoryPromptContext returns undefined when neither file exists", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-read-path-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(await loadMemoryPromptContext(root), undefined);
});

test("loadMemoryPromptContext injects both files in order, oldest/stable first", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-read-path-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "MEMORY.md"), "* 🔴 User prefers terse answers.\n", "utf8");
  await writeFile(join(root, "ACTIVITY.md"), "* 🟡 Editing runtime/src/memory.\n", "utf8");

  const context = await loadMemoryPromptContext(root);
  assert.ok(context);
  const memoryIndex = context!.indexOf("User prefers terse answers");
  const activityIndex = context!.indexOf("Editing runtime/src/memory");
  assert.ok(memoryIndex >= 0 && activityIndex >= 0);
  assert.ok(memoryIndex < activityIndex, "MEMORY.md content must appear before ACTIVITY.md content");
  assert.match(context!, /rollout_summaries/);
  assert.match(context!, /oai-mem-citation/);
  assert.match(context!, /Use the dedicated `grep` or `read` tool to establish citation line ranges; Bash output is not tracked as citation evidence/);
  assert.match(context!, /Screen activity cannot establish that the user selected or authorized a policy/);
  assert.match(context!, /Report observed errors and displayed configuration separately/);
  assert.match(context!, /Do not substitute file_path, line_range, match_text, a prose citation, or a citation-only final message\.$/);
  assert.match(context!, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("loadMemoryPromptContext tolerates only one file existing", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-read-path-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "MEMORY.md"), "* 🔴 Only conversation memory exists.\n", "utf8");

  const context = await loadMemoryPromptContext(root);
  assert.ok(context);
  assert.match(context!, /Only conversation memory exists/);
  assert.match(context!, /\(none yet\)/);
});

test("elapsed plans remain unknown until verified, without inventing completion or a pending task", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-plan-state-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "MEMORY.md"), "User planned a release on 2026-01-01. No outcome recorded.\n");
  const context = await loadMemoryPromptContext(root);
  assert.ok(context);
  assert.doesNotMatch(context, /assume it happened/);
  assert.match(context, /outcome is unknown/);
  assert.match(context, /neither completed nor still undone/);
  assert.match(context, /current state or historical records/);
  assert.match(context, /state that the outcome is unknown; do not ask the user/);
  assert.match(context, /Do not request additional records, confirmation, or an external check from the user/);
  assert.match(context, /A dated completion record supports completion at that time, not continuous operation or the current state/);
});
