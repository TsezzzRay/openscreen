import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  loadMemorySummary,
} from "../../src/harness/memory/read/summary.js";

test("limits the auto-loaded Memory summary to 2,500 locally estimated tokens", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-memory-read-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    join(root, "memory_summary.md"),
    `v1\n${"记忆条目。".repeat(4_000)}`,
  );

  const summary = await loadMemorySummary(root);

  assert(summary);
  assert(Buffer.byteLength(summary, "utf8") <= 2_500 * 4);
  assert.match(summary, /\[Memory summary truncated\]$/);
  assert.doesNotMatch(summary, /�/);
});

test("treats a missing Memory summary as no long-term context", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-memory-read-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  assert.equal(await loadMemorySummary(root), undefined);
});
