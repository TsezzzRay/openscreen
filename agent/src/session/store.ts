import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import type OpenAI from "openai";
import type { ChatImage } from "../protocol.js";

export type Turn = {
  id?: string;
  user: string;
  assistant: string;
  reasoning?: string;
  images?: ChatImage[];
  screenshotPath?: string;
  status?: "completed" | "failed" | "cancelled";
  outputItems?: Array<
    OpenAI.Responses.ResponseReasoningItem | OpenAI.Responses.ResponseOutputMessage
  >;
};

export type VisibleTurn = Pick<Turn, "id" | "user" | "assistant" | "reasoning"> & {
  id: string;
  status: "completed" | "failed" | "cancelled" | "interrupted";
  images?: ChatImage[];
  error?: string;
};

export type SessionState = {
  turns: Turn[];
  summary?: string;
  firstKeptTurnIndex: number;
};

export type StoredSession = SessionState & {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  visibleTurns: VisibleTurn[];
};

export type SessionSummary = Pick<
  StoredSession,
  "id" | "title" | "createdAt" | "updatedAt"
>;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type SessionHeader = {
  type: "session";
  id: string;
  title: string;
  createdAt: string;
};

type StartedTurn = {
  id: string;
  user: string;
  images?: ChatImage[];
  screenshotPath?: string;
  startedAt: string;
};

export type SessionEvent = {
  type: "turn_started";
  turn: StartedTurn;
} | {
  type: "reasoning_delta" | "answer_delta";
  turnId: string;
  delta: string;
} | {
  type: "turn_completed";
  turn: Turn & { id: string };
} | {
  type: "turn_failed";
  turnId: string;
  message: string;
  includeInContext?: boolean;
} | {
  type: "turn_cancelled";
  turnId: string;
} | {
  type: "context_compacted";
  summary: string;
  firstKeptTurnIndex: number;
};

export function sessionPath(directory: string, id: string) {
  if (!UUID_PATTERN.test(id)) {
    throw new Error("Invalid session ID");
  }
  return join(directory, `${id}.jsonl`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isChatImages(value: unknown): value is ChatImage[] {
  return Array.isArray(value) && value.every((image) => (
    isRecord(image) && typeof image.id === "string" && image.id.length > 0 &&
    (image.source === "system_capture" || image.source === "user_upload") &&
    typeof image.path === "string" && image.path.length > 0
  ));
}

export function turnImages(turn: { images?: ChatImage[]; screenshotPath?: string }): ChatImage[] {
  if (turn.images) return turn.images;
  return turn.screenshotPath
    ? [{ id: "legacy-system", source: "system_capture", path: turn.screenshotPath }]
    : [];
}

function visibleImages(turn: { images?: ChatImage[]; screenshotPath?: string }) {
  const images = turnImages(turn).filter((image) => image.source === "user_upload");
  return images.length > 0 ? { images } : {};
}

function isTurn(value: unknown): value is Turn & { id: string } {
  return typeof value === "object" && value !== null &&
    "id" in value && typeof value.id === "string" && value.id.length > 0 &&
    "user" in value && typeof value.user === "string" &&
    "assistant" in value && typeof value.assistant === "string" &&
    (!("images" in value) || value.images === undefined || isChatImages(value.images)) &&
    (!("screenshotPath" in value) || value.screenshotPath === undefined ||
      typeof value.screenshotPath === "string") &&
    (!("status" in value) || value.status === undefined || value.status === "completed" ||
      value.status === "failed" || value.status === "cancelled") &&
    (!("reasoning" in value) || value.reasoning === undefined ||
      typeof value.reasoning === "string") &&
    (!("outputItems" in value) || value.outputItems === undefined ||
      Array.isArray(value.outputItems));
}

function parseHeader(line: string): SessionHeader {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error("Invalid session metadata");
  }
  if (!isRecord(value) || value.type !== "session" ||
      typeof value.id !== "string" || !UUID_PATTERN.test(value.id) ||
      typeof value.title !== "string" || typeof value.createdAt !== "string") {
    throw new Error("Invalid session metadata");
  }
  return value as SessionHeader;
}

function parseEvent(line: string, lineNumber: number): SessionEvent {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error(`Invalid session event at line ${lineNumber}`);
  }
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new Error(`Invalid session event at line ${lineNumber}`);
  }
  switch (value.type) {
    case "turn_started": {
      const turn = value.turn;
      if (!isRecord(turn) || typeof turn.id !== "string" || !turn.id ||
          typeof turn.user !== "string" ||
          ("images" in turn && turn.images !== undefined && !isChatImages(turn.images)) ||
          ("screenshotPath" in turn && turn.screenshotPath !== undefined &&
            typeof turn.screenshotPath !== "string") ||
          typeof turn.startedAt !== "string") break;
      return value as SessionEvent;
    }
    case "reasoning_delta":
    case "answer_delta":
      if (typeof value.turnId === "string" && value.turnId && typeof value.delta === "string") {
        return value as SessionEvent;
      }
      break;
    case "turn_completed":
      if (isTurn(value.turn)) return value as SessionEvent;
      break;
    case "turn_failed":
      if (typeof value.turnId === "string" && value.turnId &&
          typeof value.message === "string" &&
          (!("includeInContext" in value) || value.includeInContext === undefined ||
            typeof value.includeInContext === "boolean")) {
        return value as SessionEvent;
      }
      break;
    case "turn_cancelled":
      if (typeof value.turnId === "string" && value.turnId) return value as SessionEvent;
      break;
    case "context_compacted":
      if (typeof value.summary === "string" && Number.isInteger(value.firstKeptTurnIndex) &&
          (value.firstKeptTurnIndex as number) >= 0) {
        return value as SessionEvent;
      }
  }
  throw new Error(`Invalid session event at line ${lineNumber}`);
}

async function readFirstLine(path: string): Promise<string> {
  const file = await open(path, "r");
  try {
    let line = "";
    let position = 0;
    const buffer = Buffer.alloc(4096);
    while (line.length <= 65_536) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) return line;
      const chunk = buffer.subarray(0, bytesRead).toString("utf8");
      const newline = chunk.indexOf("\n");
      if (newline >= 0) return line + chunk.slice(0, newline);
      line += chunk;
      position += bytesRead;
    }
    throw new Error("Session metadata is too large");
  } finally {
    await file.close();
  }
}

export async function appendSessionEvents(
  directory: string,
  id: string,
  events: SessionEvent[],
) {
  if (events.length === 0) return;
  await mkdir(directory, { recursive: true });
  const file = await open(sessionPath(directory, id), "a+", 0o600);
  try {
    const details = await file.stat();
    if (details.size === 0) throw new Error("Invalid session metadata");
    const lastByte = Buffer.alloc(1);
    await file.read(lastByte, 0, 1, details.size - 1);
    if (lastByte[0] !== 0x0A) {
      let position = details.size;
      let newline = -1;
      const buffer = Buffer.alloc(4_096);
      while (position > 0 && newline < 0) {
        const length = Math.min(buffer.length, position);
        position -= length;
        await file.read(buffer, 0, length, position);
        newline = buffer.subarray(0, length).lastIndexOf(0x0A);
      }
      if (newline < 0) throw new Error("Invalid session metadata");
      await file.truncate(position + newline + 1);
    }
    await file.writeFile(events.map((event) => `${JSON.stringify(event)}\n`).join(""));
    await file.sync();
  } finally {
    await file.close();
  }
}

export async function createSession(directory: string): Promise<StoredSession> {
  const timestamp = new Date().toISOString();
  const header: SessionHeader = {
    type: "session",
    id: randomUUID(),
    title: "New Chat",
    createdAt: timestamp,
  };
  await mkdir(directory, { recursive: true });
  await writeFile(sessionPath(directory, header.id), `${JSON.stringify(header)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  return {
    id: header.id,
    title: header.title,
    createdAt: header.createdAt,
    updatedAt: timestamp,
    turns: [],
    visibleTurns: [],
    firstKeptTurnIndex: 0,
  };
}

export async function loadSession(directory: string, id: string): Promise<StoredSession> {
  const path = sessionPath(directory, id);
  const contents = await readFile(path, "utf8");
  const completeLines = contents.endsWith("\n")
    ? contents.slice(0, -1).split("\n")
    : contents.split("\n").slice(0, -1);
  if (completeLines.length === 0) throw new Error("Invalid session metadata");
  const header = parseHeader(completeLines[0]!);
  if (header.id !== id) throw new Error("Session ID does not match filename");

  const turns: Turn[] = [];
  const visibleTurns: VisibleTurn[] = [];
  const visibleIndexes = new Map<string, number>();
  const pending = new Map<string, VisibleTurn>();
  const pendingTurns = new Map<string, StartedTurn>();
  let summary: string | undefined;
  let firstKeptTurnIndex = 0;

  for (let index = 1; index < completeLines.length; index += 1) {
    const event = parseEvent(completeLines[index]!, index + 1);
    switch (event.type) {
      case "turn_started": {
        if (visibleIndexes.has(event.turn.id)) {
          throw new Error(`Duplicate turn at line ${index + 1}`);
        }
        const visible: VisibleTurn = {
          id: event.turn.id,
          user: event.turn.user,
          assistant: "",
          reasoning: "",
          status: "interrupted",
          ...visibleImages(event.turn),
        };
        visibleIndexes.set(event.turn.id, visibleTurns.length);
        visibleTurns.push(visible);
        pending.set(event.turn.id, visible);
        pendingTurns.set(event.turn.id, event.turn);
        break;
      }
      case "reasoning_delta":
      case "answer_delta": {
        const visible = pending.get(event.turnId);
        if (!visible) throw new Error(`Unknown turn at line ${index + 1}`);
        if (event.type === "reasoning_delta") visible.reasoning = (visible.reasoning ?? "") + event.delta;
        else visible.assistant += event.delta;
        break;
      }
      case "turn_completed": {
        const visibleIndex = visibleIndexes.get(event.turn.id);
        if (visibleIndex === undefined || !pending.has(event.turn.id)) {
          throw new Error(`Unknown turn at line ${index + 1}`);
        }
        turns.push(event.turn);
        visibleTurns[visibleIndex] = {
          id: event.turn.id,
          user: event.turn.user,
          assistant: event.turn.assistant,
          reasoning: event.turn.reasoning,
          status: "completed",
          ...visibleImages(event.turn),
        };
        pending.delete(event.turn.id);
        pendingTurns.delete(event.turn.id);
        break;
      }
      case "turn_failed": {
        const visible = pending.get(event.turnId);
        const started = pendingTurns.get(event.turnId);
        if (!visible || !started) throw new Error(`Unknown turn at line ${index + 1}`);
        visible.status = "failed";
        visible.error = event.message;
        if (event.includeInContext) {
          turns.push({
            id: started.id,
            user: started.user,
            assistant: visible.assistant,
            reasoning: visible.reasoning,
            ...(started.images ? { images: started.images } : {}),
            ...(started.screenshotPath ? { screenshotPath: started.screenshotPath } : {}),
            status: "failed",
          });
        }
        pending.delete(event.turnId);
        pendingTurns.delete(event.turnId);
        break;
      }
      case "turn_cancelled": {
        const visible = pending.get(event.turnId);
        const started = pendingTurns.get(event.turnId);
        if (!visible || !started) throw new Error(`Unknown turn at line ${index + 1}`);
        visible.status = "cancelled";
        turns.push({
          id: started.id,
          user: started.user,
          assistant: visible.assistant,
          reasoning: visible.reasoning,
          ...(started.images ? { images: started.images } : {}),
          ...(started.screenshotPath ? { screenshotPath: started.screenshotPath } : {}),
          status: "cancelled",
        });
        pending.delete(event.turnId);
        pendingTurns.delete(event.turnId);
        break;
      }
      case "context_compacted":
        if (event.firstKeptTurnIndex > turns.length) {
          throw new Error(`Invalid compaction event at line ${index + 1}`);
        }
        summary = event.summary;
        firstKeptTurnIndex = event.firstKeptTurnIndex;
        break;
    }
  }

  return {
    id: header.id,
    title: header.title,
    createdAt: header.createdAt,
    updatedAt: (await stat(path)).mtime.toISOString(),
    turns,
    visibleTurns,
    summary,
    firstKeptTurnIndex,
  };
}

export async function listSessions(directory: string): Promise<SessionSummary[]> {
  await mkdir(directory, { recursive: true });
  const summaries: SessionSummary[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    try {
      const path = join(directory, entry.name);
      const session = parseHeader(await readFirstLine(path));
      if (`${session.id}.jsonl` !== entry.name) throw new Error("Session ID does not match filename");
      summaries.push({
        id: session.id,
        title: session.title,
        createdAt: session.createdAt,
        updatedAt: (await stat(path)).mtime.toISOString(),
      });
    } catch (error) {
      process.stderr.write(
        `Skipping invalid session ${entry.name}: ${error instanceof Error ? error.message : "unknown error"}\n`,
      );
    }
  }
  return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

async function rewriteHeader(directory: string, id: string, title: string) {
  const path = sessionPath(directory, id);
  const contents = await readFile(path, "utf8");
  const newline = contents.indexOf("\n");
  if (newline < 0) throw new Error("Invalid session metadata");
  const header = parseHeader(contents.slice(0, newline));
  if (header.id !== id) throw new Error("Session ID does not match filename");
  const temporaryPath = join(directory, `.${id}.${randomUUID()}.tmp`);
  try {
    await writeFile(
      temporaryPath,
      `${JSON.stringify({ ...header, title })}\n${contents.slice(newline + 1)}`,
      { mode: 0o600 },
    );
    const temporary = await open(temporaryPath, "r");
    try {
      await temporary.sync();
    } finally {
      await temporary.close();
    }
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export async function renameSession(
  directory: string,
  id: string,
  title: string,
): Promise<StoredSession> {
  const trimmedTitle = title.trim();
  if (!trimmedTitle) throw new Error("Session title is required");
  if (trimmedTitle.length > 100) throw new Error("Session title is too long");
  await rewriteHeader(directory, id, trimmedTitle);
  return loadSession(directory, id);
}
