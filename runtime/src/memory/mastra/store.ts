import { join } from "node:path";

import { LibSQLStore } from "@mastra/libsql";
import { Memory } from "@mastra/memory";
import { ObservationalMemory } from "@mastra/memory/processors";

import type { MemoryConfig } from "../config.js";
import { buildObservationalMemoryModel } from "./model-adapter.js";

// Two ObservationalMemory instances, not two Memory instances (confirmed in
// Stage A): Memory's own `options.observationalMemory` only activates inside
// a Mastra Agent's processor loop, which this project never runs. The
// standalone ObservationalMemory class, driven manually from write-path.ts,
// is what actually does the work — one instance per thread so `interactive`
// (Turn) and `screen-activity` (Chronicle) can carry independent
// observation/reflection thresholds, per the locked thread topology.
export interface MastraMemoryStore {
  memory: Memory;
  interactive: ObservationalMemory;
  screenActivity: ObservationalMemory;
  close(): Promise<void>;
}

const DATABASE_FILENAME = "mastra.db";

export function mastraDatabasePath(root: string): string {
  return join(root, DATABASE_FILENAME);
}

export function openMastraMemoryStore(
  root: string,
  config: MemoryConfig,
  agent: { provider: string; model: string },
): MastraMemoryStore {
  // Resolve the model BEFORE opening any file. This is the common failure
  // mode (missing MINIMAX_CN_API_KEY) — checking it first means a
  // misconfigured environment never opens mastra.db at all, instead of
  // opening it and then throwing. RetryingMemoryLifecycle retries this every
  // worker.intervalMilliseconds while broken; without this ordering (or the
  // try/catch below), each retry leaked an unclosed LibSQLStore handle —
  // observed as 124 open mastra.db/-wal/-shm file descriptors after ~5
  // minutes of retrying against a missing API key.
  const model = buildObservationalMemoryModel(agent);

  const storage = new LibSQLStore({
    id: "openscreen-memory",
    url: `file:${mastraDatabasePath(root)}`,
  });
  try {
    // No vector store / no embedder anywhere in this migration (locked
    // decision) — semantic recall stays off.
    const memory = new Memory({ storage, vector: false });
    const memoryStorage = storage.stores.memory!;

    const interactive = new ObservationalMemory({
      storage: memoryStorage,
      memory,
      scope: "thread",
      model,
      observation: {
        messageTokens: config.observationalMemory.interactive.messageTokens,
        bufferTokens: false,
      },
      reflection: {
        observationTokens: config.observationalMemory.interactive.observationTokens,
      },
    });
    const screenActivity = new ObservationalMemory({
      storage: memoryStorage,
      memory,
      scope: "thread",
      model,
      observation: {
        messageTokens: config.observationalMemory.screenActivity.messageTokens,
        bufferTokens: false,
      },
      reflection: {
        observationTokens: config.observationalMemory.screenActivity.observationTokens,
      },
    });

    return {
      memory,
      interactive,
      screenActivity,
      close: () => storage.close(),
    };
  } catch (error) {
    // Defense in depth: any other construction failure past this point must
    // not leak the already-opened storage handle either.
    void storage.close().catch(() => {});
    throw error;
  }
}
