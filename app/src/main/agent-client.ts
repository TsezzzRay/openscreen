import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { EventEmitter } from "node:events";

import type { AgentEventEnvelope, AgentStatus } from "@shared/ipc.ts";
import type { ApplicationCommand, ApplicationEvent } from "@shared/protocol.ts";

export class AgentProcessError extends Error {}

interface AgentClientEvents {
  event: [AgentEventEnvelope];
  status: [AgentStatus];
}

/**
 * Owns the Node runtime child process and the newline-delimited JSON protocol
 * on its stdin/stdout. Correlation is by `requestId`; this client does not
 * interpret command or event payloads beyond that field.
 */
export class AgentClient extends EventEmitter<AgentClientEvents> {
  private child: ChildProcessWithoutNullStreams | undefined;
  private buffer = "";
  private exited = false;
  private stopping = false;

  constructor(
    private readonly options: {
      command: string;
      args: string[];
      cwd: string;
      env: NodeJS.ProcessEnv;
      onStderr: (line: string) => void;
    },
  ) {
    super();
  }

  get running(): boolean {
    return this.child !== undefined && !this.exited;
  }

  start(): void {
    if (this.child !== undefined) return;
    this.emit("status", { state: "starting" });
    const child = spawn(this.options.command, this.options.args, {
      cwd: this.options.cwd,
      env: this.options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.consume(chunk));

    child.stderr.setEncoding("utf8");
    let stderrBuffer = "";
    child.stderr.on("data", (chunk: string) => {
      stderrBuffer += chunk;
      let index = stderrBuffer.indexOf("\n");
      while (index >= 0) {
        const line = stderrBuffer.slice(0, index);
        stderrBuffer = stderrBuffer.slice(index + 1);
        if (line.trim().length > 0) this.options.onStderr(line);
        index = stderrBuffer.indexOf("\n");
      }
    });

    child.on("error", (error) => this.settle(`Agent failed to start: ${error.message}`));
    // "close" rather than "exit": it fires after stdout has been fully drained,
    // so a final event line is never dropped on shutdown.
    child.on("close", (code, signal) => {
      const reason = signal !== null ? `signal ${signal}` : `code ${code ?? 0}`;
      this.settle(`The agent stopped (${reason}). Restart OpenScreen and try again.`);
    });

    this.emit("status", { state: "ready" });
  }

  send(command: ApplicationCommand): void {
    const child = this.child;
    if (child === undefined || this.exited) {
      throw new AgentProcessError("The agent is not running.");
    }
    child.stdin.write(JSON.stringify(command) + "\n");
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (child === undefined || this.exited || this.stopping) return;
    this.stopping = true;
    // Closing stdin is the runtime's documented graceful shutdown: its readline
    // loop ends, in-flight work settles, then it exits on its own.
    child.stdin.end();
    if (await this.waitForExit(240)) return;
    child.kill("SIGTERM");
    if (await this.waitForExit(240)) return;
    child.kill("SIGKILL");
    await this.waitForExit(200);
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    let index = this.buffer.indexOf("\n");
    while (index >= 0) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      this.dispatch(line);
      index = this.buffer.indexOf("\n");
    }
  }

  private dispatch(line: string): void {
    if (line.trim().length === 0) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.options.onStderr(`Unparseable agent line: ${line.slice(0, 200)}`);
      return;
    }
    if (typeof parsed !== "object" || parsed === null) return;
    const record = parsed as Record<string, unknown>;
    const requestId = record["requestId"];
    if (typeof requestId !== "string" || requestId.length === 0) return;
    const { requestId: _omitted, ...rest } = record;
    this.emit("event", { requestId, event: rest as unknown as ApplicationEvent });
  }

  private settle(message: string): void {
    if (this.exited) return;
    this.exited = true;
    this.emit("status", { state: "stopped", message });
  }

  private waitForExit(milliseconds: number): Promise<boolean> {
    if (this.exited) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(this.exited), milliseconds);
      const check = setInterval(() => {
        if (!this.exited) return;
        clearInterval(check);
        clearTimeout(timer);
        resolve(true);
      }, 20);
      timer.unref?.();
      check.unref?.();
    });
  }
}
