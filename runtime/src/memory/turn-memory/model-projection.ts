import type {
  TurnMemoryBatchProjection,
  TurnMemorySource,
} from "./types.js";

function timestamp(value: string, name: string): number {
  const result = Date.parse(value);
  if (!Number.isFinite(result)) throw new Error(`Invalid ${name}`);
  return result;
}

function sameProvenance(
  left: TurnMemorySource,
  right: TurnMemorySource,
): boolean {
  return left.threadId === right.threadId &&
    left.sessionId === right.sessionId &&
    left.cwd === right.cwd &&
    left.gitBranch === right.gitBranch &&
    left.rolloutPath === right.rolloutPath;
}

export function projectTurnMemoryBatch(
  inputSources: readonly TurnMemorySource[],
): TurnMemoryBatchProjection {
  if (inputSources.length === 0) {
    throw new Error("Turn Memory batch requires at least one source");
  }
  const sources = [...inputSources].sort((left, right) =>
    timestamp(left.occurredAt, "Turn occurrence") -
      timestamp(right.occurredAt, "Turn occurrence") ||
    left.sourceId.localeCompare(right.sourceId)
  );
  const first = sources[0]!;
  if (sources.some((source) => !sameProvenance(first, source))) {
    throw new Error("Turn Memory batch requires the same Session provenance");
  }
  if (new Set(sources.map(({ sourceId }) => sourceId)).size !== sources.length) {
    throw new Error("Turn Memory batch contains duplicate source IDs");
  }
  let startedAt = first.startedAt;
  let finishedAt = first.finishedAt;
  for (const source of sources) {
    if (timestamp(source.startedAt, "Turn start") < timestamp(startedAt, "Turn start")) {
      startedAt = source.startedAt;
    }
    if (timestamp(source.finishedAt, "Turn finish") > timestamp(finishedAt, "Turn finish")) {
      finishedAt = source.finishedAt;
    }
  }
  return {
    type: "turn_memory_batch",
    threadId: first.threadId,
    sessionId: first.sessionId,
    cwd: first.cwd,
    gitBranch: first.gitBranch,
    rolloutPath: first.rolloutPath,
    sourceIds: sources.map(({ sourceId }) => sourceId),
    startedAt,
    finishedAt,
    turns: sources.map((source) => ({
      sourceId: source.sourceId,
      status: source.status,
      startedAt: source.startedAt,
      finishedAt: source.finishedAt,
      user: source.user,
      assistant: source.assistant,
      sourceFrameIds: [...source.sourceFrameIds],
      ...(source.compactionSummary === undefined
        ? {}
        : { compactionSummary: source.compactionSummary }),
      ...(source.terminalError === undefined
        ? {}
        : { terminalError: source.terminalError }),
      tools: source.tools.map((tool) => ({ ...tool })),
    })),
  };
}
