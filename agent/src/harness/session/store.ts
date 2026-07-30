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

import {
  isSessionId,
  parseSessionHeader,
  replaySession,
  type SessionEvent,
  type SessionHeader,
} from "./events.js";
import type {
  SessionSummary,
  StoredSession,
} from "./types.js";

export function sessionPath(directory: string, id: string) {
  if (!isSessionId(id)) {
    throw new Error("Invalid session ID");
  }
  return join(directory, `${id}.jsonl`);
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
    agentRuns: [],
    firstKeptTurnIndex: 0,
  };
}

export async function loadSession(directory: string, id: string): Promise<StoredSession> {
  const path = sessionPath(directory, id);
  const contents = await readFile(path, "utf8");
  const completeLines = contents.endsWith("\n")
    ? contents.slice(0, -1).split("\n")
    : contents.split("\n").slice(0, -1);
  return replaySession(
    completeLines,
    id,
    (await stat(path)).mtime.toISOString(),
  );
}

export async function listSessions(directory: string): Promise<SessionSummary[]> {
  await mkdir(directory, { recursive: true });
  const summaries: SessionSummary[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    try {
      const path = join(directory, entry.name);
      const session = parseSessionHeader(await readFirstLine(path));
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
  const header = parseSessionHeader(contents.slice(0, newline));
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
