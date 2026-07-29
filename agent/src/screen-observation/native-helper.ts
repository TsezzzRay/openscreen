import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createInterface, type Interface } from "node:readline";

import {
  HELPER_PROTOCOL_VERSION,
  encodeHelperCommand,
  parseHelperOutput,
  type HelperOutput,
} from "./helper-protocol.js";
import type {
  NativeActivitySignal,
  NativeCaptureResult,
  NativeHelperConfiguration,
} from "./types.js";

export type HelperLifecycle = "starting" | "ready" | "restarting" | "degraded" | "stopped";

type NativeHelperOptions = {
  command: string;
  arguments?: string[];
  environment?: NodeJS.ProcessEnv;
  currentDirectory?: string;
  excludedProcessIdentifiers: number[];
  excludedBundleIdentifiers: string[];
  configuration: NativeHelperConfiguration;
  maxRestarts: number;
  restartDelayMilliseconds: number;
  configurationTimeoutMilliseconds: number;
  shutdownTimeoutMilliseconds: number;
  onSignal: (signal: NativeActivitySignal) => void;
  onLifecycle?: (state: HelperLifecycle) => void;
};

type PendingCapture = {
  resolve: (result: NativeCaptureResult) => void;
  reject: (error: Error) => void;
};

export class NativeHelperClient {
  private child?: ChildProcessWithoutNullStreams;
  private outputLines?: Interface;
  private readonly pendingCaptures = new Map<string, PendingCapture>();
  private configured = false;
  private desiredRunning = false;
  private restartCount = 0;
  private restartTimer?: NodeJS.Timeout;
  private configurationRequestId?: string;
  private configurationTimer?: NodeJS.Timeout;
  private lifecycle?: HelperLifecycle;
  private startPromise?: Promise<void>;
  private resolveFirstStart?: () => void;
  private rejectFirstStart?: (error: Error) => void;

  constructor(private readonly options: NativeHelperOptions) {}

  get running() {
    return this.configured && this.child?.exitCode === null;
  }

  start() {
    if (this.startPromise !== undefined) return this.startPromise;
    this.desiredRunning = true;
    this.startPromise = new Promise<void>((resolve, reject) => {
      this.resolveFirstStart = resolve;
      this.rejectFirstStart = reject;
      this.launch("starting");
    });
    return this.startPromise;
  }

  capture(signal: NativeActivitySignal) {
    if (!this.running || this.child === undefined) {
      return Promise.reject(new Error("Observation helper is not ready"));
    }
    const requestId = randomUUID();
    const result = new Promise<NativeCaptureResult>((resolve, reject) => {
      this.pendingCaptures.set(requestId, { resolve, reject });
    });
    this.child.stdin.write(encodeHelperCommand({
      protocolVersion: HELPER_PROTOCOL_VERSION,
      requestId,
      type: "capture",
      signal,
    }), (error) => {
      if (!error) return;
      const pending = this.pendingCaptures.get(requestId);
      this.pendingCaptures.delete(requestId);
      pending?.reject(error);
    });
    return result;
  }

  async stop() {
    this.desiredRunning = false;
    if (this.restartTimer !== undefined) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }
    const child = this.child;
    if (child === undefined || child.exitCode !== null) {
      this.finishStopped();
      return;
    }
    const requestId = randomUUID();
    child.stdin.write(encodeHelperCommand({
      protocolVersion: HELPER_PROTOCOL_VERSION,
      requestId,
      type: "shutdown",
    }));
    child.stdin.end();
    await Promise.race([
      once(child, "close").then(() => undefined),
      new Promise<void>((resolve) => setTimeout(
        resolve,
        this.options.shutdownTimeoutMilliseconds,
      )),
    ]);
    if (child.exitCode === null) child.kill();
    this.finishStopped();
  }

  private launch(state: HelperLifecycle) {
    if (!this.desiredRunning) return;
    this.clearConfigurationHandshake();
    this.configured = false;
    this.notifyLifecycle(state);
    const child = spawn(this.options.command, this.options.arguments ?? [], {
      cwd: this.options.currentDirectory,
      env: this.options.environment ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.outputLines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.outputLines.on("line", (line) => this.consume(child, line));
    child.stderr.on("data", (data: Buffer) => {
      process.stderr.write(`OpenScreen observation helper: ${data.toString()}`);
    });
    let finished = false;
    const finish = (error: Error) => {
      if (finished) return;
      finished = true;
      this.handleExit(child, error);
    };
    child.once("error", (error) => finish(error));
    child.once("close", (code, signal) => finish(
      new Error(`Observation helper exited (${signal ?? code ?? "unknown"})`),
    ));
  }

  private consume(child: ChildProcessWithoutNullStreams, line: string) {
    if (child !== this.child) return;
    let output: HelperOutput;
    try {
      output = parseHelperOutput(line);
    } catch (error) {
      process.stderr.write(
        `Invalid observation helper output: ${error instanceof Error ? error.message : "unknown"}\n`,
      );
      child.kill();
      return;
    }
    if (output.type === "ready") {
      const requestId = randomUUID();
      this.configurationRequestId = requestId;
      this.configurationTimer = setTimeout(() => {
        this.failChild(
          child,
          new Error("Observation helper configuration timed out"),
        );
      }, this.options.configurationTimeoutMilliseconds);
      child.stdin.write(encodeHelperCommand({
        protocolVersion: HELPER_PROTOCOL_VERSION,
        requestId,
        type: "configure",
        excludedProcessIdentifiers: this.options.excludedProcessIdentifiers,
        excludedBundleIdentifiers: this.options.excludedBundleIdentifiers,
        configuration: this.options.configuration,
      }), (error) => {
        if (error) this.failChild(child, error);
      });
      return;
    }
    if (output.type === "configured") {
      if (output.requestId !== this.configurationRequestId) return;
      this.clearConfigurationHandshake();
      this.configured = true;
      this.notifyLifecycle("ready");
      this.resolveFirstStart?.();
      this.resolveFirstStart = undefined;
      this.rejectFirstStart = undefined;
      return;
    }
    if (output.type === "signal") {
      this.options.onSignal(output.signal);
      return;
    }
    if (output.type === "captureResult") {
      const pending = this.pendingCaptures.get(output.requestId);
      if (pending === undefined) return;
      this.pendingCaptures.delete(output.requestId);
      pending.resolve(output.result);
      return;
    }
    if (
      output.type === "error" &&
      output.requestId === this.configurationRequestId
    ) {
      this.clearConfigurationHandshake();
      this.failChild(child, new Error(`${output.code}: ${output.message}`));
      return;
    }
    if (output.type === "error" && output.requestId !== undefined) {
      const pending = this.pendingCaptures.get(output.requestId);
      if (pending === undefined) return;
      this.pendingCaptures.delete(output.requestId);
      pending.reject(new Error(`${output.code}: ${output.message}`));
    }
  }

  private handleExit(child: ChildProcessWithoutNullStreams, error: Error) {
    if (child !== this.child) return;
    this.clearConfigurationHandshake();
    this.outputLines?.close();
    this.outputLines = undefined;
    this.child = undefined;
    this.configured = false;
    for (const pending of this.pendingCaptures.values()) pending.reject(error);
    this.pendingCaptures.clear();
    if (!this.desiredRunning) {
      this.finishStopped();
      return;
    }
    if (this.restartCount >= this.options.maxRestarts) {
      this.desiredRunning = false;
      this.notifyLifecycle("degraded");
      this.rejectFirstStart?.(error);
      this.resolveFirstStart = undefined;
      this.rejectFirstStart = undefined;
      return;
    }
    this.restartCount += 1;
    this.notifyLifecycle("restarting");
    this.restartTimer = setTimeout(
      () => {
        this.restartTimer = undefined;
        this.launch("starting");
      },
      this.options.restartDelayMilliseconds,
    );
  }

  private finishStopped() {
    this.clearConfigurationHandshake();
    this.outputLines?.close();
    this.outputLines = undefined;
    this.child = undefined;
    this.configured = false;
    const error = new Error("Observation helper stopped");
    for (const pending of this.pendingCaptures.values()) pending.reject(error);
    this.pendingCaptures.clear();
    this.notifyLifecycle("stopped");
  }

  private notifyLifecycle(state: HelperLifecycle) {
    if (this.lifecycle === state) return;
    this.lifecycle = state;
    this.options.onLifecycle?.(state);
  }

  private clearConfigurationHandshake() {
    if (this.configurationTimer !== undefined) {
      clearTimeout(this.configurationTimer);
      this.configurationTimer = undefined;
    }
    this.configurationRequestId = undefined;
  }

  private failChild(child: ChildProcessWithoutNullStreams, error: Error) {
    if (child !== this.child) return;
    this.handleExit(child, error);
    if (child.exitCode === null) child.kill();
  }
}
