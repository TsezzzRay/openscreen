import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { sessionPath } from "./store.js";

function lockPath(directory: string, id: string) {
  sessionPath(directory, id);
  return join(directory, `${id}.lock`);
}

function processExists(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function withSessionLock<T>(
  directory: string,
  id: string,
  operation: () => Promise<T>,
): Promise<T> {
  await mkdir(directory, { recursive: true });
  const path = lockPath(directory, id);
  const token = randomUUID();
  while (true) {
    try {
      const lock = await open(path, "wx", 0o600);
      try {
        await lock.writeFile(JSON.stringify({ pid: process.pid, token }));
        await lock.sync();
      } finally {
        await lock.close();
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const owner = JSON.parse(await readFile(path, "utf8")) as { pid?: unknown };
        if (typeof owner.pid !== "number" || !processExists(owner.pid)) {
          await rm(path, { force: true });
          continue;
        }
      } catch (readError) {
        if ((readError as NodeJS.ErrnoException).code === "ENOENT") continue;
        let age: number;
        try {
          age = Date.now() - (await stat(path)).mtimeMs;
        } catch (statError) {
          if ((statError as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw statError;
        }
        if (age >= 5_000) {
          await rm(path, { force: true });
          continue;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  try {
    return await operation();
  } finally {
    try {
      const owner = JSON.parse(await readFile(path, "utf8")) as { token?: unknown };
      if (owner.token === token) await rm(path, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
