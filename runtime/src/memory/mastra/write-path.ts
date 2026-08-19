import { MessageList } from "@mastra/core/agent";
import type { Memory } from "@mastra/memory";
import type { ObservationalMemory } from "@mastra/memory/processors";

import type { MastraMemoryStore } from "./store.js";
import type { MemoryArtifact, MemoryProjector } from "./projector.js";
import { MEMORY_THREAD_IDS } from "./thread-ids.js";

// One resource, two long-lived threads, decoupled from pi's per-Session IDs
// (they persist for the app's whole lifetime — never one thread per pi
// Session, or cross-Session memory would reset every time a Session is
// created). pi Session JSONL remains the sole authority for what the live
// Agent turn actually sees; these threads are a separate, independent copy
// that only feeds Observer/Reflector, mirroring how today's memory.sqlite3
// is already a separate re-derived copy rather than a replacement.
const RESOURCE_ID = MEMORY_THREAD_IDS.resourceId;
const INTERACTIVE_THREAD_ID = MEMORY_THREAD_IDS.interactive;
const SCREEN_ACTIVITY_THREAD_ID = MEMORY_THREAD_IDS.screenActivity;

export interface WritePathDeps {
  store: MastraMemoryStore;
  projector: MemoryProjector;
}

async function ensureThread(
  memory: Memory,
  threadId: string,
  title: string,
): Promise<void> {
  const existing = await memory.getThreadById({ threadId, resourceId: RESOURCE_ID });
  if (existing) return;
  await memory.createThread({
    threadId,
    resourceId: RESOURCE_ID,
    title,
    saveThread: true,
  });
}

async function saveAndObserve(
  memory: Memory,
  om: ObservationalMemory,
  threadId: string,
  text: string,
): Promise<void> {
  const list = new MessageList({ threadId, resourceId: RESOURCE_ID });
  list.add([{ role: "user", content: text }], "memory");
  await memory.saveMessages({ messages: list.get.all.db() });
  // Confirmed cheap/idempotent when under threshold (Stage A): safe to call
  // unconditionally after every save rather than pre-checking a threshold
  // ourselves.
  await om.observe({ threadId, resourceId: RESOURCE_ID });
}

/** Record one completed Turn: feeds its text to the interactive OM instance and archives the rollout. */
export async function recordInteractiveTurn(
  deps: WritePathDeps,
  observationText: string,
  artifact: MemoryArtifact,
): Promise<void> {
  await ensureThread(deps.store.memory, INTERACTIVE_THREAD_ID, "Interactive memory");
  await saveAndObserve(deps.store.memory, deps.store.interactive, INTERACTIVE_THREAD_ID, observationText);
  await deps.projector.appendRollout(artifact);
}

/** Record one summarized Chronicle window: feeds its text to the screen-activity OM instance and archives the rollout. */
export async function recordChronicleWindow(
  deps: WritePathDeps,
  observationText: string,
  artifact: MemoryArtifact,
): Promise<void> {
  await ensureThread(deps.store.memory, SCREEN_ACTIVITY_THREAD_ID, "Screen activity memory");
  await saveAndObserve(deps.store.memory, deps.store.screenActivity, SCREEN_ACTIVITY_THREAD_ID, observationText);
  await deps.projector.appendRollout(artifact);
}

export { MEMORY_THREAD_IDS } from "./thread-ids.js";
