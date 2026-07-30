import {
  mkdir,
  open,
  readFile,
  type FileHandle,
} from "node:fs/promises";
import { join } from "node:path";

import type { MemoryEvent } from "./types.js";

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
