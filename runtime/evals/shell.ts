import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { shellQuote } from "../src/agent/pi/tools/tool-support.js";

function scrubbedShellEnvironment(scratch: string): NodeJS.ProcessEnv {
  const environment = Object.fromEntries(Object.keys(process.env).map(key => [key, ""]));
  return {
    ...environment,
    HOME: scratch,
    TMPDIR: scratch,
    NODE_TEST_CONTEXT: undefined,
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
  };
}

export class SandboxedEvalShell extends NodeExecutionEnv {
  private readonly scratch: string;

  constructor(private readonly workspace: string, private readonly writable = true) {
    const scratch = join(dirname(workspace), "shell-home");
    super({ cwd: workspace, shellEnv: scrubbedShellEnvironment(scratch) });
    this.scratch = scratch;
  }

  override exec(command: string, options: Parameters<NodeExecutionEnv["exec"]>[1] = {}) {
    if (process.platform !== "darwin") {
      return Promise.resolve({ ok: false as const, error: new Error("Eval Bash requires the macOS sandbox") as never });
    }
    const profile = [
      "(version 1)",
      "(deny default)",
      "(allow process*)",
      "(allow sysctl-read)",
      "(allow file-read*)",
      `(deny file-read-data ${[homedir(), "/private/etc", "/private/var/folders", "/Volumes"].map(path => `(subpath ${JSON.stringify(path)})`).join(" ")})`,
      `(allow file-read-data ${[this.workspace, realpathSync(this.workspace), this.scratch, realpathSync(this.scratch), dirname(process.execPath), resolve(dirname(process.execPath), "../lib/node_modules/npm")].map(path => `(subpath ${JSON.stringify(path)})`).join(" ")})`,
      '(allow file-write* (literal "/dev/null"))',
      ...(this.writable ? [`(allow file-write* ${[this.workspace, realpathSync(this.workspace), this.scratch, realpathSync(this.scratch)].map(path => `(subpath ${JSON.stringify(path)})`).join(" ")})`] : []),
      "(deny network*)",
    ].join(" ");
    const wrapped = `/usr/bin/sandbox-exec -p ${shellQuote(profile)} /bin/bash -c ${shellQuote(command)}; eval_sandbox_status=$?; exit $eval_sandbox_status`;
    return super.exec(wrapped, options);
  }
}
