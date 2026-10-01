import { realpathSync } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { ExecutionError } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";

import { shellQuote } from "../agent/pi/tools/tool-support.js";

function shellEnvironment(outputRoot: string): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(Object.keys(process.env).map(key => [key, ""])),
    HOME: outputRoot,
    TMPDIR: outputRoot,
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
  };
}

async function hasExternalHardLinks(root: string, signal?: AbortSignal): Promise<boolean> {
  const links = new Map<string, { present: number; total: number }>();
  const visit = async (directory: string): Promise<void> => {
    for (const name of await readdir(directory)) {
      if (signal?.aborted) throw new ExecutionError("aborted", "aborted");
      const path = join(directory, name);
      const info = await lstat(path);
      if (info.isDirectory()) await visit(path);
      else if (info.isFile() && info.nlink > 1) {
        const key = `${info.dev}:${info.ino}`;
        const entry = links.get(key);
        if (entry) entry.present += 1;
        else links.set(key, { present: 1, total: info.nlink });
      }
    }
  };
  await visit(root);
  return [...links.values()].some(({ present, total }) => present < total);
}

export class SandboxedToolShell extends NodeExecutionEnv {
  private readonly profile: string;
  private readonly outputRoot: string;

  constructor(options: { cwd: string; outputRoot: string }) {
    const outputRoot = realpathSync(options.outputRoot);
    super({ cwd: resolve(options.cwd), shellEnv: shellEnvironment(outputRoot) });
    this.outputRoot = outputRoot;
    this.profile = [
      "(version 1)",
      "(deny default)",
      "(allow process*)",
      "(allow sysctl-read)",
      "(allow file-read*)",
      '(allow file-write* (literal "/dev/null"))',
      `(allow file-write* (subpath ${JSON.stringify(outputRoot)}))`,
      "(deny network*)",
    ].join(" ");
  }

  override async exec(command: string, options: Parameters<NodeExecutionEnv["exec"]>[1] = {}) {
    if (process.platform !== "darwin") {
      return { ok: false as const, error: new ExecutionError("unknown", "Tool shell requires the macOS sandbox") };
    }
    try {
      if (await hasExternalHardLinks(this.outputRoot, options.abortSignal)) {
        return { ok: false as const, error: new ExecutionError("unknown", "Task output contains a hard link to a file outside the output directory") };
      }
    } catch (error) {
      return { ok: false as const, error: error instanceof ExecutionError
        ? error
        : new ExecutionError("unknown", `Cannot inspect task output before shell execution: ${error instanceof Error ? error.message : String(error)}`) };
    }
    const wrapped = `/usr/bin/sandbox-exec -p ${shellQuote(this.profile)} /bin/bash -c ${shellQuote(command)}`;
    return super.exec(wrapped, { ...options, env: undefined });
  }
}
