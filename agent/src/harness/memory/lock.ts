import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  readdir,
  rmdir,
  stat,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";

function processExists(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function withMemoryLock<T>(
  root: string,
  operation: () => Promise<T>,
): Promise<T> {
  await mkdir(root, { recursive: true });
  const path = join(root, ".activity-memory.lock");
  const token = randomUUID();
  const ownerPath = join(path, `owner-${token}.json`);
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
        const ownerName = names.find((name) => /^owner-.+\.json$/.test(name));
        if (ownerName) {
          staleEntryPath = join(path, ownerName);
          const owner = JSON.parse(
            await readFile(staleEntryPath, "utf8"),
          ) as { pid?: unknown };
          removable = typeof owner.pid === "number"
            ? !processExists(owner.pid)
            : Date.now() - (await stat(path)).mtimeMs >= 5_000;
        } else {
          removable = names.length === 0 &&
            Date.now() - (await stat(path)).mtimeMs >= 5_000;
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
