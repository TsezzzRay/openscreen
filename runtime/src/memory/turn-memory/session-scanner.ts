import type {
  JsonlSessionMetadata,
  Session,
} from "@earendil-works/pi-agent-core";

import type { TurnMemoryRepository } from "./repository.js";
import { projectTerminalTurnSources } from "./session-projection.js";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function scanTurnMemorySession({
  session,
  fileVersion,
  gitBranch,
  repository,
  scannedAt = Date.now(),
}: {
  session: Session<JsonlSessionMetadata>;
  fileVersion: string;
  gitBranch: string;
  repository: TurnMemoryRepository;
  scannedAt?: number;
}): Promise<
  | { status: "unchanged" }
  | {
      status: "scanned";
      ingested: number;
      updated: number;
      deactivated: number;
    }
  | { status: "failed"; error: string }
> {
  const metadata = await session.getMetadata();
  if (!repository.shouldScan(metadata.id, fileVersion)) {
    return { status: "unchanged" };
  }
  try {
    const cursor = repository.loadScanCursor(metadata.id);
    const projection = await projectTerminalTurnSources(session, {
      gitBranch,
      ...(cursor?.lastTerminalEntryId === undefined
        ? {}
        : { afterEntryId: cursor.lastTerminalEntryId }),
    });
    return {
      status: "scanned",
      ...repository.commitScan({
        sessionId: metadata.id,
        fileVersion,
        projection,
        scannedAt,
      }),
    };
  } catch (error) {
    const message = errorMessage(error);
    repository.recordScanFailure({
      sessionId: metadata.id,
      fileVersion,
      error: message,
      scannedAt,
    });
    return { status: "failed", error: message };
  }
}
