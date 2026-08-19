import type {
  JsonlSessionMetadata,
  Session,
} from "@earendil-works/pi-agent-core";

import type { MemoryCursors } from "../cursors.js";
import { projectTerminalTurnSources } from "./session-projection.js";
import type { TerminalTurnProjection, TurnMemorySource } from "./types.js";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function scanTurnMemorySession({
  session,
  fileVersion,
  gitBranch,
  cursors,
  onTerminalSource,
  scannedAt = Date.now(),
}: {
  session: Session<JsonlSessionMetadata>;
  fileVersion: string;
  gitBranch: string;
  cursors: MemoryCursors;
  onTerminalSource: (source: TurnMemorySource) => Promise<void>;
  scannedAt?: number;
}): Promise<
  | { status: "unchanged" }
  | { status: "scanned"; processed: number; cursorRewound: boolean }
  | { status: "failed"; error: string }
> {
  const metadata = await session.getMetadata();
  if (!cursors.shouldScanSession(metadata.id, fileVersion)) {
    return { status: "unchanged" };
  }
  let projection: TerminalTurnProjection;
  try {
    const cursor = cursors.loadTurnScanCursor(metadata.id);
    projection = await projectTerminalTurnSources(session, {
      gitBranch,
      ...(cursor?.lastTerminalEntryId === undefined
        ? {}
        : { afterEntryId: cursor.lastTerminalEntryId }),
    });
  } catch (error) {
    // A deterministic parse failure (e.g. a malformed Session). Recording it
    // against the current fileVersion matches shouldScanSession's semantics:
    // retrying without the file changing would fail identically, so wait for
    // a change before trying again.
    const message = errorMessage(error);
    cursors.recordTurnScanFailure({
      sessionId: metadata.id,
      fileVersion,
      error: message,
      scannedAt,
    });
    return { status: "failed", error: message };
  }
  // onTerminalSource writes to Mastra and can fail transiently (network).
  // Deliberately do NOT record anything against the cursor on that failure —
  // leaving it at its last successful position means the next tick retries
  // this whole unprocessed range from scratch. A partial retry may re-send an
  // already-written source to Mastra, which is harmless: an idempotent file
  // overwrite for the rollout, and a duplicate observation the Observer
  // simply sees twice.
  try {
    for (const source of projection.sources) {
      await onTerminalSource(source);
    }
  } catch (error) {
    return { status: "failed", error: errorMessage(error) };
  }
  cursors.recordTurnScanSuccess({
    sessionId: metadata.id,
    fileVersion,
    lastTerminalEntryId: projection.nextEntryId,
    scannedAt,
  });
  return {
    status: "scanned",
    processed: projection.sources.length,
    cursorRewound: projection.cursorRewound,
  };
}
