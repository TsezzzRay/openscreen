import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { MemoryConfig } from "../../../src/memory/config.js";
import { createMemoryProjector } from "../../../src/memory/mastra/projector.js";
import { openMastraMemoryStore, type MastraMemoryStore } from "../../../src/memory/mastra/store.js";
import {
  MEMORY_THREAD_IDS,
  recordChronicleWindow,
  recordInteractiveTurn,
  type WritePathDeps,
} from "../../../src/memory/mastra/write-path.js";

process.env.MINIMAX_CN_API_KEY ??= "test-key";
const HUGE = 100_000_000;

async function withWritePath(
  root: string,
  fn: (writePath: WritePathDeps, store: MastraMemoryStore) => Promise<void>,
): Promise<void> {
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
    { provider: "minimax-cn", model: "test-model" },
  );
  try {
    await fn({ store, projector: createMemoryProjector(root, store) }, store);
  } finally {
    await store.close();
  }
}

test("recordInteractiveTurn creates the interactive thread, saves the message, and archives the rollout", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-write-path-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await withWritePath(root, async (writePath, store) => {
    await recordInteractiveTurn(writePath, "User: hi. Assistant: hello.", {
      relativePath: "rollout_summaries/turn-1.md",
      content: "turn content\n",
    });
    const thread = await store.memory.getThreadById({
      threadId: MEMORY_THREAD_IDS.interactive,
      resourceId: MEMORY_THREAD_IDS.resourceId,
    });
    assert.ok(thread);
    assert.equal(
      await readFile(join(root, "rollout_summaries", "turn-1.md"), "utf8"),
      "turn content\n",
    );
  });
});

test("recordChronicleWindow creates the screen-activity thread, saves the message, and archives the rollout", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-write-path-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await withWritePath(root, async (writePath, store) => {
    await recordChronicleWindow(writePath, "Activity: editing code.", {
      relativePath: "rollout_summaries/chronicle-1.md",
      content: "chronicle content\n",
    });
    const thread = await store.memory.getThreadById({
      threadId: MEMORY_THREAD_IDS.screenActivity,
      resourceId: MEMORY_THREAD_IDS.resourceId,
    });
    assert.ok(thread);
    assert.equal(
      await readFile(join(root, "rollout_summaries", "chronicle-1.md"), "utf8"),
      "chronicle content\n",
    );
  });
});

test("recording twice reuses the same thread instead of recreating it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-write-path-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await withWritePath(root, async (writePath, store) => {
    await recordInteractiveTurn(writePath, "First turn.", {
      relativePath: "rollout_summaries/turn-1.md",
      content: "1\n",
    });
    const before = await store.memory.getThreadById({
      threadId: MEMORY_THREAD_IDS.interactive,
      resourceId: MEMORY_THREAD_IDS.resourceId,
    });
    await recordInteractiveTurn(writePath, "Second turn.", {
      relativePath: "rollout_summaries/turn-2.md",
      content: "2\n",
    });
    const after = await store.memory.getThreadById({
      threadId: MEMORY_THREAD_IDS.interactive,
      resourceId: MEMORY_THREAD_IDS.resourceId,
    });
    assert.equal(before?.createdAt?.getTime?.(), after?.createdAt?.getTime?.());
  });
});
