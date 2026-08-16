import type {
  JsonlSessionMetadata,
  Session,
  SessionTreeEntry,
} from "@earendil-works/pi-agent-core";

import type {
  TerminalTurnProjection,
  TerminalTurnStatus,
  TurnMemorySource,
  TurnMemoryToolResult,
} from "./types.js";

const USER_TEXT_MAX_CHARACTERS = 12_000;
const ASSISTANT_TEXT_MAX_CHARACTERS = 12_000;
const TOOL_RESULT_MAX_CHARACTERS = 2_000;
const COMPACTION_MAX_CHARACTERS = 4_000;

interface PendingTurn {
  userEntryIds: string[];
  startedAt: string;
  userParts: string[];
  tools: TurnMemoryToolResult[];
  sourceFrameIds: string[];
  compactionSummary?: string;
}

function boundedText(value: string, maxCharacters: number): string {
  const normalized = value.replace(/\r\n/g, "\n").trim();
  const characters = Array.from(normalized);
  if (characters.length <= maxCharacters) return normalized;
  return `${characters.slice(0, maxCharacters - 1).join("")}…`;
}

function contentText(
  content: string | Array<{ type: string; text?: string }>,
): string {
  if (typeof content === "string") return content;
  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("");
}

function sourceFrameIds(
  content: string | Array<{ type: string; text?: string }>,
): string[] {
  const text = contentText(content).trim();
  if (!text) return [];
  try {
    const value: unknown = JSON.parse(text);
    if (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      "frames" in value &&
      Array.isArray(value.frames)
    ) {
      const ids = value.frames.flatMap((frame) => {
        if (
          typeof frame !== "object" ||
          frame === null ||
          Array.isArray(frame) ||
          !("sourceId" in frame) ||
          typeof frame.sourceId !== "string" ||
          !frame.sourceId.trim()
        ) {
          return [];
        }
        return [frame.sourceId];
      });
      return [...new Set(ids)];
    }
  } catch {
    return [];
  }
  return [];
}

function assistantText(
  content: Array<{ type: string; text?: string }>,
): string {
  const text = content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("");
  const start = text.lastIndexOf("<oai-mem-citation>");
  if (start < 0) return text;
  const end = text.indexOf("</oai-mem-citation>", start);
  return end >= 0 && !text.slice(end + "</oai-mem-citation>".length).trim()
    ? text.slice(0, start).trimEnd()
    : text;
}

function terminalStatus(
  stopReason: string,
): TerminalTurnStatus | undefined {
  switch (stopReason) {
    case "stop":
      return "completed";
    case "error":
      return "failed";
    case "aborted":
      return "cancelled";
    case "length":
      return "interrupted";
    default:
      return undefined;
  }
}

function sourceFromTerminal(
  metadata: JsonlSessionMetadata,
  gitBranch: string,
  turn: PendingTurn,
  entry: Extract<SessionTreeEntry, { type: "message" }>,
  status: TerminalTurnStatus,
): TurnMemorySource {
  if (entry.message.role !== "assistant") {
    throw new Error("Terminal Turn entry must be an assistant message");
  }
  const firstUserEntryId = turn.userEntryIds[0];
  if (firstUserEntryId === undefined) {
    throw new Error("Terminal Turn requires a user entry");
  }
  const terminalError = entry.message.errorMessage?.trim();
  return {
    sourceId: `turn:${metadata.id}:${firstUserEntryId}`,
    threadId: metadata.id,
    sessionId: metadata.id,
    cwd: metadata.cwd,
    gitBranch,
    rolloutPath: metadata.path,
    userEntryIds: turn.userEntryIds,
    terminalEntryId: entry.id,
    startedAt: turn.startedAt,
    finishedAt: entry.timestamp,
    occurredAt: entry.timestamp,
    status,
    user: boundedText(turn.userParts.join("\n\n"), USER_TEXT_MAX_CHARACTERS),
    assistant: boundedText(
      assistantText(entry.message.content),
      ASSISTANT_TEXT_MAX_CHARACTERS,
    ),
    sourceFrameIds: [...turn.sourceFrameIds],
    ...(turn.compactionSummary === undefined
      ? {}
      : { compactionSummary: turn.compactionSummary }),
    ...(terminalError ? { terminalError } : {}),
    tools: turn.tools,
  };
}

function customSourceFrameIds(
  entry: SessionTreeEntry,
): string[] {
  if (entry.type === "custom_message") {
    return entry.customType === "openscreen.injected-context"
      ? sourceFrameIds(entry.content)
      : [];
  }
  if (
    entry.type === "message" &&
    entry.message.role === "custom" &&
    entry.message.customType === "openscreen.injected-context"
  ) {
    return sourceFrameIds(entry.message.content);
  }
  return [];
}

function toolResult(
  entry: Extract<SessionTreeEntry, { type: "message" }>,
): TurnMemoryToolResult | undefined {
  const message = entry.message;
  if (message.role === "toolResult") {
    return {
      name: message.toolName,
      status: message.isError ? "failed" : "completed",
      result: boundedText(
        contentText(message.content),
        TOOL_RESULT_MAX_CHARACTERS,
      ),
    };
  }
  if (message.role === "bashExecution") {
    return {
      name: "bash",
      status: message.exitCode === undefined || message.exitCode === 0
        ? "completed"
        : "failed",
      result: boundedText(message.output, TOOL_RESULT_MAX_CHARACTERS),
    };
  }
  return undefined;
}

export async function projectTerminalTurnSources(
  session: Session<JsonlSessionMetadata>,
  options: { gitBranch: string; afterEntryId?: string },
): Promise<TerminalTurnProjection> {
  if (!options.gitBranch.trim()) throw new Error("Turn Memory requires a Git branch");
  const [metadata, branch] = await Promise.all([
    session.getMetadata(),
    session.getBranch(),
  ]);
  const cursorIndex = options.afterEntryId === undefined
    ? -1
    : branch.findIndex((entry) => entry.id === options.afterEntryId);
  const cursorRewound = options.afterEntryId !== undefined && cursorIndex < 0;
  const entries = branch.slice(cursorRewound ? 0 : cursorIndex + 1);
  const sources: TurnMemorySource[] = [];
  let nextEntryId = cursorRewound ? undefined : options.afterEntryId;
  let pendingCompaction: string | undefined;
  let turn: PendingTurn | undefined;

  for (const entry of entries) {
    if (entry.type === "compaction") {
      if (turn === undefined) {
        pendingCompaction = boundedText(
          entry.summary,
          COMPACTION_MAX_CHARACTERS,
        );
      }
      continue;
    }
    if (entry.type === "message" && entry.message.role === "user") {
      const text = contentText(entry.message.content);
      if (turn === undefined) {
        turn = {
          userEntryIds: [entry.id],
          startedAt: entry.timestamp,
          userParts: [text],
          tools: [],
          sourceFrameIds: [],
          ...(pendingCompaction === undefined
            ? {}
            : { compactionSummary: pendingCompaction }),
        };
        pendingCompaction = undefined;
      } else {
        turn.userEntryIds.push(entry.id);
        turn.userParts.push(text);
      }
      continue;
    }
    if (turn === undefined) continue;

    const frameIds = customSourceFrameIds(entry);
    if (frameIds.length > 0) {
      turn.sourceFrameIds = [...new Set([...turn.sourceFrameIds, ...frameIds])];
      continue;
    }
    if (entry.type !== "message") continue;
    const tool = toolResult(entry);
    if (tool !== undefined) {
      turn.tools.push(tool);
      continue;
    }
    if (entry.message.role !== "assistant") continue;
    const status = terminalStatus(entry.message.stopReason);
    if (status === undefined) continue;
    sources.push(sourceFromTerminal(metadata, options.gitBranch, turn, entry, status));
    nextEntryId = entry.id;
    turn = undefined;
  }

  return {
    sources,
    ...(nextEntryId === undefined ? {} : { nextEntryId }),
    cursorRewound,
  };
}
