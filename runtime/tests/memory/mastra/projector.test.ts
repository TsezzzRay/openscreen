import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createMemoryProjector } from "../../../src/memory/mastra/projector.js";
import { openMastraMemoryStore, type MastraMemoryStore } from "../../../src/memory/mastra/store.js";
import type { MemoryConfig } from "../../../src/memory/config.js";

process.env.MINIMAX_CN_API_KEY ??= "test-key";
const HUGE = 100_000_000;

async function withStore(root: string, fn: (store: MastraMemoryStore) => Promise<void>): Promise<void> {
  const store = openMastraMemoryStore(
    root,
    {
      enabled: true,
      worker: { intervalMilliseconds: 5_000, maxChronicleWindowsPerTick: 2 },
      chronicle: { windowMilliseconds: 60_000, graceMilliseconds: 0, maxSourcesPerRequest: 10, maxInputTokens: 8_000, maxOutputTokens: 2_000 },
      observationalMemory: {
        interactive: { messageTokens: HUGE, observationTokens: HUGE },
        screenActivity: { messageTokens: HUGE, observationTokens: HUGE },
      },
      retention: { chronicleRolloutMaxAgeMilliseconds: HUGE },
    } satisfies MemoryConfig,
    {
      provider: "minimax-cn",
      id: "test-model",
      api: "anthropic-messages",
      baseUrl: "https://api.minimaxi.com/anthropic",
    },
  );
  try {
    await fn(store);
  } finally {
    await store.close();
  }
}

test("appendRollout writes the file atomically at the given relative path", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-projector-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await withStore(root, async (store) => {
    const projector = createMemoryProjector(root, store);
    await projector.appendRollout({ relativePath: "rollout_summaries/turn-x.md", content: "hello world\n" });
    assert.equal(
      await readFile(join(root, "rollout_summaries", "turn-x.md"), "utf8"),
      "hello world\n",
    );
  });
});

test("appendRollout rejects absolute paths and paths that escape the Memory root", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-projector-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await withStore(root, async (store) => {
    const projector = createMemoryProjector(root, store);
    await assert.rejects(() => projector.appendRollout({ relativePath: "/etc/passwd", content: "x" }));
    await assert.rejects(() => projector.appendRollout({ relativePath: "../outside.md", content: "x" }));
  });
});

test("projectObservationLogs writes both files, empty when there are no observations yet", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-projector-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await withStore(root, async (store) => {
    const projector = createMemoryProjector(root, store);
    await projector.projectObservationLogs();
    assert.equal(await readFile(join(root, "MEMORY.md"), "utf8"), "");
    assert.equal(await readFile(join(root, "ACTIVITY.md"), "utf8"), "");
  });
});

test("pruneChronicleRollouts removes only chronicle files older than the cutoff", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-projector-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await withStore(root, async (store) => {
    const projector = createMemoryProjector(root, store);
    await projector.appendRollout({ relativePath: "rollout_summaries/chronicle-old.md", content: "old" });
    await projector.appendRollout({ relativePath: "rollout_summaries/chronicle-new.md", content: "new" });
    await projector.appendRollout({ relativePath: "rollout_summaries/turn-old.md", content: "turn" });

    const oldTime = new Date(Date.now() - 200 * 24 * 60 * 60_000);
    await utimes(join(root, "rollout_summaries", "chronicle-old.md"), oldTime, oldTime);
    await utimes(join(root, "rollout_summaries", "turn-old.md"), oldTime, oldTime);

    const removed = await projector.pruneChronicleRollouts(90 * 24 * 60 * 60_000);
    assert.deepEqual(removed, ["chronicle-old.md"]);

    const remaining = await readdir(join(root, "rollout_summaries"));
    assert.deepEqual(remaining.sort(), ["chronicle-new.md", "turn-old.md"]);
  });
});

test("pruneChronicleRollouts tolerates a missing rollout_summaries directory", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-projector-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await withStore(root, async (store) => {
    const projector = createMemoryProjector(root, store);
    assert.deepEqual(await projector.pruneChronicleRollouts(90 * 24 * 60 * 60_000), []);
  });
});
