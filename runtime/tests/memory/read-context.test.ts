import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createMemoryReadPath,
  loadMemoryPromptContext,
} from "../../src/memory/read-context.js";

test("loads a bounded untrusted summary with Codex-style file search rules", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-memory-read-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "rollout_summaries"));
  await writeFile(join(root, "memory_summary.md"), [
    "v1",
    "",
    "## General Tips",
    "- Search for node:sqlite and 记住.",
    "",
  ].join("\n"));

  const context = await loadMemoryPromptContext(root, 2_500);

  assert.match(context ?? "", /untrusted historical data/i);
  assert.match(context ?? "", /memory_summary\.md is already injected/i);
  assert.match(context ?? "", /MEMORY\.md/);
  assert.match(context ?? "", /rollout_summaries/);
  for (const tool of ["grep", "read", "bash"]) {
    assert.match(context ?? "", new RegExp(`\\b${tool}\\b`, "i"));
  }
  assert.match(context ?? "", /1–2/);
  assert.match(context ?? "", /node:sqlite/);
  assert.match(context ?? "", /记住/);
  assert.match(context ?? "", new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("skips a missing summary and rejects invalid or oversized summaries", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-memory-read-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(await loadMemoryPromptContext(root, 100), undefined);

  await writeFile(join(root, "memory_summary.md"), "not-v1\n");
  await assert.rejects(loadMemoryPromptContext(root, 100), /v1/);
  await writeFile(
    join(root, "memory_summary.md"),
    `v1\n\n${"historical memory ".repeat(1_000)}`,
  );
  await assert.rejects(loadMemoryPromptContext(root, 100), /token budget/i);
});

test("disables both Memory prompt loading and citation tracking", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-memory-read-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "memory_summary.md"), "not-v1\n");

  assert.equal(createMemoryReadPath(root, {
    enabled: false,
    summaryMaxTokens: 100,
  }), undefined);
  const enabled = createMemoryReadPath(root, {
    enabled: true,
    summaryMaxTokens: 100,
  });
  assert.equal(enabled?.root, root);
  await assert.rejects(enabled?.loadPromptContext(), /v1/);
});
