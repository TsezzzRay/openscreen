import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import type { ObservationalMemory } from "@mastra/memory/processors";

import { MEMORY_THREAD_IDS } from "./thread-ids.js";

// Replaces artifact-projector.ts. No job queue, no crash-replay bookkeeping:
// this is a straight "also write this text to a file" side effect alongside
// the Mastra write, not a source of truth. Two kinds of file:
//  - MEMORY.md / ACTIVITY.md: whole-log projections of each OM instance's
//    getObservations() — both injected every turn and greppable. Written
//    whole, no filtering, no XML stripping (confirmed in Stage A: no
//    <observation-group> tags appear without `retrieval` configured).
//  - rollout_summaries/*.md: a provenance-headed archive written in parallel
//    with the Mastra save, from the text already in hand — this is the only
//    place exact pre-compression detail survives, since OM discards raw
//    messages once observed. Mastra never prunes this, so the projector runs
//    its own simple age-based prune over the chronicle half of it (turn
//    rollouts follow pi Session lifecycle, matching today's behavior where
//    Session files are not deleted by this product).

export interface MemoryArtifact {
  relativePath: string;
  content: string;
}

export interface MemoryProjector {
  appendRollout(artifact: MemoryArtifact): Promise<void>;
  projectObservationLogs(): Promise<void>;
  pruneChronicleRollouts(maxAgeMilliseconds: number, now?: number): Promise<string[]>;
}

function artifactPath(root: string, relativePath: string): string {
  if (isAbsolute(relativePath)) throw new Error("Memory artifact path must be relative");
  const target = resolve(root, relativePath);
  const fromRoot = relative(resolve(root), target);
  if (fromRoot === ".." || fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new Error("Memory artifact path escapes Memory root");
  }
  return target;
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${randomUUID()}`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
    await chmod(path, 0o600);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

// LibSQL creates OM's tables lazily on the first actual write (saveMessages +
// observe), not at construction time. On a genuinely fresh install,
// getObservations() runs before any write has ever happened — e.g. the
// projectObservationLogs() call inside MemoryRuntime.start() — and throws
// "no such table" rather than returning undefined. Treat that specific
// failure as "no observations yet"; anything else still propagates.
async function getObservationsOrUndefined(
  om: ObservationalMemory,
  threadId: string,
  resourceId: string,
): Promise<string | undefined> {
  try {
    return await om.getObservations(threadId, resourceId);
  } catch (error) {
    if (error instanceof Error && /no such table/i.test(error.message)) return undefined;
    throw error;
  }
}

export function createMemoryProjector(
  root: string,
  om: { interactive: ObservationalMemory; screenActivity: ObservationalMemory },
): MemoryProjector {
  return {
    async appendRollout(artifact: MemoryArtifact): Promise<void> {
      await mkdir(root, { recursive: true, mode: 0o700 });
      await chmod(root, 0o700);
      await atomicWrite(artifactPath(root, artifact.relativePath), artifact.content);
    },

    async projectObservationLogs(): Promise<void> {
      const [interactiveText, screenActivityText] = await Promise.all([
        getObservationsOrUndefined(om.interactive, MEMORY_THREAD_IDS.interactive, MEMORY_THREAD_IDS.resourceId),
        getObservationsOrUndefined(om.screenActivity, MEMORY_THREAD_IDS.screenActivity, MEMORY_THREAD_IDS.resourceId),
      ]);
      await mkdir(root, { recursive: true, mode: 0o700 });
      await chmod(root, 0o700);
      await Promise.all([
        atomicWrite(artifactPath(root, "MEMORY.md"), interactiveText ?? ""),
        atomicWrite(artifactPath(root, "ACTIVITY.md"), screenActivityText ?? ""),
      ]);
    },

    async pruneChronicleRollouts(maxAgeMilliseconds: number, now = Date.now()): Promise<string[]> {
      const rolloutDir = artifactPath(root, "rollout_summaries");
      let entries: string[];
      try {
        entries = await readdir(rolloutDir);
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
        throw error;
      }
      const cutoff = now - maxAgeMilliseconds;
      const removed: string[] = [];
      for (const entry of entries) {
        if (!entry.startsWith("chronicle-") || !entry.endsWith(".md")) continue;
        const path = join(rolloutDir, entry);
        const info = await stat(path);
        if (info.mtimeMs <= cutoff) {
          await rm(path, { force: true });
          removed.push(entry);
        }
      }
      return removed;
    },
  };
}
