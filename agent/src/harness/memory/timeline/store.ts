import {
  mkdir,
  open,
  readFile,
  readdir,
  type FileHandle,
} from "node:fs/promises";
import { join } from "node:path";

import type { TimelineEntry } from "./types.js";

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
