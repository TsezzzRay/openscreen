import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface WriteOptions {
  approvedPath?: string;
  expectedContent?: string;
  expectedAbsent?: boolean;
  append?: boolean;
  signal?: AbortSignal;
}

export class SandboxedFileWriter {
  private readonly outputRoot: string;

  constructor(outputRoot: string) {
    this.outputRoot = realpathSync(outputRoot);
  }

  async write(path: string, content: string, options: WriteOptions = {}): Promise<void> {
    if (process.platform !== "darwin") throw new Error("File writes require the macOS sandbox");
    if (options.append && options.approvedPath) throw new Error("Approved writes may not append");
    const target = resolve(path);
    const approved = options.approvedPath === undefined ? undefined : resolve(options.approvedPath);
    if (approved !== undefined && approved !== target) throw new Error("Approval target does not match write target");
    const canonicalApproved = approved === undefined ? undefined : join(realpathSync(dirname(approved)), basename(approved));
    if (canonicalApproved !== undefined && canonicalApproved !== approved) {
      throw new Error("Destination changed after approval; request a new approval");
    }
    const stagePath = canonicalApproved === undefined ? undefined : join(dirname(canonicalApproved), `.openscreen-${randomUUID()}.tmp`);
    const profile = [
      "(version 1)",
      "(deny default)",
      "(allow process*)",
      "(allow sysctl-read)",
      "(allow mach-lookup)",
      "(allow file-read*)",
      `(allow file-write* (subpath ${JSON.stringify(this.outputRoot)}))`,
      ...(canonicalApproved === undefined ? [] : [`(allow file-write* (literal ${JSON.stringify(canonicalApproved)}))`]),
      ...(stagePath === undefined ? [] : [`(allow file-write* (literal ${JSON.stringify(stagePath)}))`]),
      "(deny network*)",
    ].join(" ");
    const worker = fileURLToPath(new URL("./file-worker.js", import.meta.url));
    const environment = {
      ...Object.fromEntries(Object.keys(process.env).map(key => [key, ""])),
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      ...(process.env.ELECTRON_RUN_AS_NODE === "1" ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
    };
    try {
      await new Promise<void>((done, fail) => {
        const child = spawn("/usr/bin/sandbox-exec", ["-p", profile, process.execPath, worker], {
          env: environment,
          stdio: ["pipe", "pipe", "pipe"],
          signal: options.signal,
        });
        let stderr = "";
        let processError: Error | undefined;
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk: string) => { stderr += chunk; });
        child.stdin.on("error", (error) => { processError = error; child.kill(); });
        child.on("error", (error) => { processError = error; });
        child.on("close", code => processError ? fail(processError) : code === 0 ? done() : fail(new Error(stderr.trim() || `Sandboxed write exited ${code}`)));
        child.stdin.end(JSON.stringify({
          path: canonicalApproved ?? target,
          content,
          ...(options.expectedContent === undefined ? {} : { expectedContent: options.expectedContent }),
          ...(options.expectedAbsent === undefined ? {} : { expectedAbsent: options.expectedAbsent }),
          ...(options.append === undefined ? {} : { append: options.append }),
          ...(stagePath === undefined ? {} : { stagePath }),
          createParents: approved === undefined,
        }));
      });
    } finally {
      if (stagePath !== undefined) {
        try { await unlink(stagePath); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
    }
  }

  append(path: string, content: string, signal?: AbortSignal): Promise<void> {
    return this.write(path, content, { append: true, signal });
  }
}
