import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { link, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

interface WriteRequest {
  path: string;
  content: string;
  expectedContent?: string;
  expectedAbsent?: boolean;
  append?: boolean;
  createParents: boolean;
  stagePath?: string;
}

async function destinationMode(request: WriteRequest): Promise<number | undefined> {
  let handle;
  try {
    handle = await open(request.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (request.expectedContent !== undefined) throw new Error("Source changed after approval; request a new approval");
    return undefined;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1) throw new Error("File write target must be a regular file without hard links");
    if (request.expectedAbsent || (request.expectedContent !== undefined && await handle.readFile("utf8") !== request.expectedContent)) {
      throw new Error("Source changed after approval; request a new approval");
    }
    return info.mode & 0o777;
  } finally {
    await handle.close();
  }
}

async function run(): Promise<void> {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    const request = JSON.parse(Buffer.concat(chunks).toString("utf8")) as WriteRequest;
    if (typeof request.path !== "string" || typeof request.content !== "string") throw new Error("Invalid write request");
    if (request.stagePath !== undefined && (
      dirname(request.stagePath) !== dirname(request.path) || request.append || request.createParents
    )) throw new Error("Invalid approved write staging path");
    if (request.createParents) await mkdir(dirname(request.path), { recursive: true });
    if (request.stagePath !== undefined) {
      try {
        const mode = await destinationMode(request);
        if (mode !== undefined) {
          // macOS cp -p retains mode, ownership, ACLs, and extended attributes.
          // The stage path has its own literal sandbox grant; the approved path
          // remains untouched until the staged content is published.
          await execFileAsync("/bin/cp", ["-p", "-n", request.path, request.stagePath]);
        }
        const staged = await open(
          request.stagePath,
          constants.O_WRONLY | constants.O_NOFOLLOW |
            (mode === undefined ? constants.O_CREAT | constants.O_EXCL : 0),
          mode ?? 0o666,
        );
        try {
          const info = await staged.stat();
          if (!info.isFile() || info.nlink !== 1) throw new Error("File write stage must be a regular file without hard links");
          await staged.truncate(0);
          const content = Buffer.from(request.content, "utf8");
          let offset = 0;
          while (offset < content.length) {
            const { bytesWritten } = await staged.write(content, offset, content.length - offset, offset);
            if (bytesWritten === 0) throw new Error("File write made no progress");
            offset += bytesWritten;
          }
          if (mode !== undefined) await staged.chmod(mode);
          await staged.sync();
        } finally {
          await staged.close();
        }
        await destinationMode(request);
        if (request.expectedAbsent) await link(request.stagePath, request.path);
        else await rename(request.stagePath, request.path);
        process.stdout.write("ok");
        return;
      } finally {
        try { await unlink(request.stagePath); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
    }
    const flags = constants.O_NOFOLLOW |
      (request.expectedContent !== undefined ? constants.O_RDWR : constants.O_WRONLY) |
      (request.expectedAbsent ? constants.O_CREAT | constants.O_EXCL : request.expectedContent === undefined ? constants.O_CREAT : 0) |
      (request.append ? constants.O_APPEND : 0);
    const handle = await open(request.path, flags, 0o666);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1) throw new Error("File write target must be a regular file without hard links");
      if (request.expectedContent !== undefined && await handle.readFile("utf8") !== request.expectedContent) {
        throw new Error("Source changed after approval; request a new approval");
      }
      if (!request.append) await handle.truncate(0);
      const content = Buffer.from(request.content, "utf8");
      let offset = 0;
      while (offset < content.length) {
        const { bytesWritten } = await handle.write(content, offset, content.length - offset, request.append ? null : offset);
        if (bytesWritten === 0) throw new Error("File write made no progress");
        offset += bytesWritten;
      }
    } finally {
      await handle.close();
    }
    process.stdout.write("ok");
  } catch (error) {
    process.stderr.write(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

await run();
