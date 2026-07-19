import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type OpenAI from "openai";

export type Turn = {
  id?: string;
  user: string;
  assistant: string;
  reasoning?: string;
  screenshotPath: string;
  outputItems?: Array<
    OpenAI.Responses.ResponseReasoningItem | OpenAI.Responses.ResponseOutputMessage
  >;
};

export type SessionState = {
  turns: Turn[];
  summary?: string;
  firstKeptTurnIndex: number;
};

export type StoredSession = SessionState & {
  version: 1;
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
};

export type SessionSummary = Pick<
  StoredSession,
  "id" | "title" | "createdAt" | "updatedAt"
>;
const MIN_RECENT_TURNS = 2;

function sessionPath(directory: string, id: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    throw new Error("Invalid session ID");
  }
  return join(directory, `${id}.json`);
}

function isTurn(value: unknown): value is Turn {
  return typeof value === "object" && value !== null &&
    "id" in value && typeof value.id === "string" && value.id.length > 0 &&
    "user" in value && typeof value.user === "string" &&
    "assistant" in value && typeof value.assistant === "string" &&
    "screenshotPath" in value && typeof value.screenshotPath === "string" &&
    (!("reasoning" in value) || value.reasoning === undefined ||
      typeof value.reasoning === "string") &&
    (!("outputItems" in value) || value.outputItems === undefined ||
      Array.isArray(value.outputItems));
}

function parseSession(json: string): StoredSession {
  const value: unknown = JSON.parse(json);
  const firstKeptTurnIndex = typeof value === "object" && value !== null &&
    "firstKeptTurnIndex" in value ? value.firstKeptTurnIndex : undefined;
  if (
    typeof value !== "object" || value === null ||
    !("version" in value) || value.version !== 1 ||
    !("id" in value) || typeof value.id !== "string" ||
    !("title" in value) || typeof value.title !== "string" ||
    !("createdAt" in value) || typeof value.createdAt !== "string" ||
    !("updatedAt" in value) || typeof value.updatedAt !== "string" ||
    !("turns" in value) || !Array.isArray(value.turns) || !value.turns.every(isTurn) ||
    ("summary" in value && value.summary !== undefined && typeof value.summary !== "string") ||
    !Number.isInteger(firstKeptTurnIndex) || (firstKeptTurnIndex as number) < 0 ||
    (firstKeptTurnIndex as number) > value.turns.length
  ) {
    throw new Error("Invalid session file");
  }
  return value as StoredSession;
}

export async function saveSession(directory: string, session: StoredSession) {
  await mkdir(directory, { recursive: true });
  const path = sessionPath(directory, session.id);
  const temporaryPath = join(directory, `.${session.id}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, `${JSON.stringify(session)}\n`, { mode: 0o600 });
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export async function createSession(directory: string): Promise<StoredSession> {
  const timestamp = new Date().toISOString();
  const session: StoredSession = {
    version: 1,
    id: randomUUID(),
    title: "New Chat",
    createdAt: timestamp,
    updatedAt: timestamp,
    turns: [],
    firstKeptTurnIndex: 0,
  };
  await saveSession(directory, session);
  return session;
}

export async function loadSession(directory: string, id: string): Promise<StoredSession> {
  return parseSession(await readFile(sessionPath(directory, id), "utf8"));
}

export async function listSessions(directory: string): Promise<SessionSummary[]> {
  await mkdir(directory, { recursive: true });
  const summaries: SessionSummary[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    try {
      const session = parseSession(await readFile(join(directory, entry.name), "utf8"));
      summaries.push({
        id: session.id,
        title: session.title,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      });
    } catch (error) {
      process.stderr.write(
        `Skipping invalid session ${entry.name}: ${error instanceof Error ? error.message : "unknown error"}\n`,
      );
    }
  }
  return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function renameSession(
  directory: string,
  id: string,
  title: string,
): Promise<StoredSession> {
  const trimmedTitle = title.trim();
  if (!trimmedTitle) throw new Error("Session title is required");
  if (trimmedTitle.length > 100) throw new Error("Session title is too long");
  const session = await loadSession(directory, id);
  session.title = trimmedTitle;
  session.updatedAt = new Date().toISOString();
  await saveSession(directory, session);
  return session;
}

export async function compactSession(
  session: SessionState,
  keepRecentTokens: number,
  countTurns: (turns: Turn[]) => Promise<number>,
  summarize: (previousSummary: string | undefined, turns: Turn[]) => Promise<string>,
): Promise<boolean> {
  const latestFirstKeptTurnIndex = Math.max(
    session.firstKeptTurnIndex,
    session.turns.length - MIN_RECENT_TURNS,
  );
  let firstKeptTurnIndex = latestFirstKeptTurnIndex;

  if (
    latestFirstKeptTurnIndex > session.firstKeptTurnIndex &&
    await countTurns(session.turns.slice(latestFirstKeptTurnIndex)) <= keepRecentTokens
  ) {
    let low = session.firstKeptTurnIndex;
    let high = latestFirstKeptTurnIndex;
    while (low < high) {
      const candidate = Math.floor((low + high) / 2);
      if (await countTurns(session.turns.slice(candidate)) <= keepRecentTokens) {
        high = candidate;
      } else {
        low = candidate + 1;
      }
    }
    firstKeptTurnIndex = low;
  }

  if (firstKeptTurnIndex <= session.firstKeptTurnIndex) return false;

  const summary = await summarize(
    session.summary,
    session.turns.slice(session.firstKeptTurnIndex, firstKeptTurnIndex),
  );
  session.summary = summary;
  session.firstKeptTurnIndex = firstKeptTurnIndex;
  return true;
}

export async function compactIfNeeded(
  compactAtTokens: number,
  countInputTokens: () => Promise<number>,
  compact: () => Promise<boolean | void>,
): Promise<number> {
  let inputTokens = await countInputTokens();
  if (inputTokens < compactAtTokens) return inputTokens;

  if (await compact() === false) {
    throw new Error("Current request exceeds the model context budget");
  }
  inputTokens = await countInputTokens();
  if (inputTokens >= compactAtTokens) {
    throw new Error("Compacted request still exceeds the model context budget");
  }
  return inputTokens;
}
