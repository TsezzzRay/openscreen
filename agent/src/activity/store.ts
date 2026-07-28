import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  readdir,
  rmdir,
  stat,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { join } from "node:path";

import type {
  MemoryEvent,
  TimelineEntry,
} from "./types.js";

function day(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf())) throw new Error("Invalid activity timestamp");
  return date.toISOString().slice(0, 10);
}

async function readCompleteLines(path: string) {
  const contents = await readFile(path, "utf8");
  return contents.endsWith("\n")
    ? contents.slice(0, -1).split("\n").filter(Boolean)
    : contents.split("\n").slice(0, -1).filter(Boolean);
}

async function truncateIncompleteTail(file: FileHandle) {
  const details = await file.stat();
  if (details.size === 0) return;
  const lastByte = Buffer.alloc(1);
  await file.read(lastByte, 0, 1, details.size - 1);
  if (lastByte[0] === 0x0A) return;

  let position = details.size;
  let newline = -1;
  const buffer = Buffer.alloc(4_096);
  while (position > 0 && newline < 0) {
    const length = Math.min(buffer.length, position);
    position -= length;
    await file.read(buffer, 0, length, position);
    newline = buffer.subarray(0, length).lastIndexOf(0x0A);
  }
  await file.truncate(newline < 0 ? 0 : position + newline + 1);
}

export async function appendTimelineEntry(
  root: string,
  entry: TimelineEntry,
) {
  const directory = join(root, "timeline");
  await mkdir(directory, { recursive: true });
  const file = await open(join(directory, `${day(entry.occurredAt)}.jsonl`), "a+", 0o600);
  try {
    await truncateIncompleteTail(file);
    await file.writeFile(`${JSON.stringify(entry)}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
}

export async function readTimelineEntries(root: string): Promise<TimelineEntry[]> {
  const directory = join(root, "timeline");
  await mkdir(directory, { recursive: true });
  const names = (await readdir(directory))
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
    .sort();
  const entries: TimelineEntry[] = [];
  for (const name of names) {
    for (const line of await readCompleteLines(join(directory, name))) {
      entries.push(JSON.parse(line) as TimelineEntry);
    }
  }
  return entries;
}

export async function appendMemoryEvent(root: string, event: MemoryEvent) {
  const directory = join(root, "memory");
  await mkdir(directory, { recursive: true });
  const file = await open(join(directory, "events.jsonl"), "a+", 0o600);
  try {
    await truncateIncompleteTail(file);
    await file.writeFile(`${JSON.stringify(event)}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
}

export async function readMemoryEvents(root: string): Promise<MemoryEvent[]> {
  const directory = join(root, "memory");
  await mkdir(directory, { recursive: true });
  const path = join(directory, "events.jsonl");
  try {
    return (await readCompleteLines(path)).map(
      (line) => JSON.parse(line) as MemoryEvent,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function processExists(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function withActivityLock<T>(
  root: string,
  operation: () => Promise<T>,
): Promise<T> {
  await mkdir(root, { recursive: true });
  const path = join(root, ".activity-memory.lock");
  const token = randomUUID();
  const ownerPath = join(path, `owner-${token}.json`);
  // ponytail: one global lock keeps JSONL source checks and appends atomic;
  // split by store only if model processing throughput becomes a measured bottleneck.
  while (true) {
    try {
      await mkdir(path, { mode: 0o700 });
      try {
        const lock = await open(ownerPath, "wx", 0o600);
        try {
          await lock.writeFile(JSON.stringify({ pid: process.pid, token }));
          await lock.sync();
        } finally {
          await lock.close();
        }
      } catch (ownerError) {
        if ((ownerError as NodeJS.ErrnoException).code === "ENOENT") continue;
        try {
          await unlink(ownerPath);
        } catch (unlinkError) {
          if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") {
            throw unlinkError;
          }
        }
        await rmdir(path);
        throw ownerError;
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let staleEntryPath: string | undefined;
      let removable = false;
      try {
        const names = await readdir(path);
        const ownerName = names.find(
          (name) => /^owner-.+\.json$/.test(name),
        );
        if (ownerName) {
          staleEntryPath = join(path, ownerName);
          const owner = JSON.parse(
            await readFile(staleEntryPath, "utf8"),
          ) as { pid?: unknown };
          removable = typeof owner.pid === "number"
            ? !processExists(owner.pid)
            : Date.now() - (await stat(path)).mtimeMs >= 5_000;
        } else {
          const legacyRecovery = names.find((name) => name === "recovery");
          if (legacyRecovery) staleEntryPath = join(path, legacyRecovery);
          removable = Date.now() - (await stat(path)).mtimeMs >= 5_000;
        }
      } catch (readError) {
        if ((readError as NodeJS.ErrnoException).code === "ENOENT") continue;
        try {
          removable = Date.now() - (await stat(path)).mtimeMs >= 5_000;
        } catch (statError) {
          if ((statError as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw statError;
        }
      }
      if (removable && staleEntryPath) {
        try {
          await unlink(staleEntryPath);
          await rmdir(path);
          continue;
        } catch (removeError) {
          if ((removeError as NodeJS.ErrnoException).code === "ENOENT" ||
              (removeError as NodeJS.ErrnoException).code === "ENOTEMPTY") {
            continue;
          }
          throw removeError;
        }
      }
      if (removable) {
        try {
          await rmdir(path);
          continue;
        } catch (removeError) {
          if ((removeError as NodeJS.ErrnoException).code === "ENOENT" ||
              (removeError as NodeJS.ErrnoException).code === "ENOTEMPTY") {
            continue;
          }
          throw removeError;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  try {
    return await operation();
  } finally {
    try {
      const owner = JSON.parse(await readFile(ownerPath, "utf8")) as { token?: unknown };
      if (owner.token === token) {
        await unlink(ownerPath);
        await rmdir(path);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
