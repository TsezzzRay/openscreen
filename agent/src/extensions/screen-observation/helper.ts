import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createInterface, type Interface } from "node:readline";

import {
  InvalidCaptureResultError,
  NonJSONHelperOutputError,
  encodeHelperCommand,
  parseHelperOutput,
  type HelperOutput,
  type NativeActivitySignal,
  type NativeCaptureResult,
  type NativeHelperConfiguration,
  type WindowMetadata,
} from "./protocol.js";

export type HelperLifecycle = "starting" | "ready" | "failed" | "stopped";
export type HelperComponentStatus = Extract<HelperOutput, { type: "status" }>;

type NativeHelperOptions = {
  command: string;
  arguments?: string[];
  environment?: NodeJS.ProcessEnv;
  currentDirectory?: string;
  excludedProcessIdentifiers: number[];
  excludedBundleIdentifiers: string[];
  configuration: NativeHelperConfiguration;
  configurationTimeoutMilliseconds: number;
  captureTimeoutMilliseconds: number;
  shutdownTimeoutMilliseconds: number;
  onSignal: (signal: NativeActivitySignal) => void;
  onLifecycle?: (state: HelperLifecycle) => void;
  onComponentStatus?: (status: HelperComponentStatus) => void;
  onDiagnostic?: (
    event: Extract<HelperOutput, { type: "diagnostic" }>,
  ) => void;
  onFatalError?: (error: Error) => void;
};

type PendingCapture = {
  resolve: (result: NativeCaptureResult) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export class HelperCaptureError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "HelperCaptureError";
  }
}

export class NativeHelperClient {
  private child?: ChildProcessWithoutNullStreams;
  private outputLines?: Interface;
  private readonly pendingCaptures = new Map<string, PendingCapture>();
  private configured = false;
  private desiredRunning = false;
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
      this.launch();
    });
    return this.startPromise;
  }

  capture(target: WindowMetadata) {
    if (!this.running || this.child === undefined) {
      return Promise.reject(new HelperCaptureError(
        "helper_not_ready",
        "Observation helper is not ready",
      ));
    }
    const requestId = randomUUID();
    const result = new Promise<NativeCaptureResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.takePendingCapture(requestId);
        pending?.reject(new HelperCaptureError(
          "capture_timeout",
          "Observation helper capture timed out",
        ));
      }, this.options.captureTimeoutMilliseconds);
      this.pendingCaptures.set(requestId, { resolve, reject, timer });
    });
    this.child.stdin.write(encodeHelperCommand({
      requestId,
      type: "capture",
      target,
    }), (error) => {
      if (!error) return;
      const pending = this.takePendingCapture(requestId);
      pending?.reject(error);
    });
    return result;
  }

  async stop() {
    this.desiredRunning = false;
    const child = this.child;
    if (child === undefined || child.exitCode !== null) {
      this.finishStopped();
      return;
    }
    const requestId = randomUUID();
    child.stdin.write(encodeHelperCommand({
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

  private launch() {
    if (!this.desiredRunning) return;
    this.clearConfigurationHandshake();
    this.configured = false;
    this.notifyLifecycle("starting");
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
      if (error instanceof NonJSONHelperOutputError) {
        process.stderr.write("Ignored non-JSON observation helper output\n");
        return;
      }
      if (error instanceof InvalidCaptureResultError) {
        const pending = this.takePendingCapture(error.requestId);
        pending?.reject(error);
        return;
      }
      process.stderr.write(
        `Invalid observation helper output: ${error instanceof Error ? error.message : "unknown"}\n`,
      );
      this.failChild(
        child,
        error instanceof Error ? error : new Error("Invalid observation helper output"),
      );
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
    if (output.type === "status") {
      this.options.onComponentStatus?.(output);
      return;
    }
    if (output.type === "diagnostic") {
      this.options.onDiagnostic?.(output);
      return;
    }
    if (output.type === "captureResult") {
      const pending = this.takePendingCapture(output.requestId);
      if (pending === undefined) return;
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
      const pending = this.takePendingCapture(output.requestId);
      if (pending === undefined) return;
      pending.reject(new HelperCaptureError(output.code, output.message));
      return;
    }
    if (output.type === "error") {
      this.failChild(child, new Error(`${output.code}: ${output.message}`));
    }
  }

  private handleExit(child: ChildProcessWithoutNullStreams, error: Error) {
    if (child !== this.child) return;
    this.clearConfigurationHandshake();
    this.outputLines?.close();
    this.outputLines = undefined;
    this.child = undefined;
    this.configured = false;
    this.rejectPendingCaptures(error);
    if (!this.desiredRunning) {
      this.finishStopped();
      return;
    }
    this.desiredRunning = false;
    this.notifyLifecycle("failed");
    this.rejectFirstStart?.(error);
    this.clearStartAttempt();
    this.options.onFatalError?.(error);
  }

  private finishStopped() {
    this.clearConfigurationHandshake();
    this.outputLines?.close();
    this.outputLines = undefined;
    this.child = undefined;
    this.configured = false;
    const error = new Error("Observation helper stopped");
    this.rejectPendingCaptures(error);
    this.rejectFirstStart?.(error);
    this.clearStartAttempt();
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

  private clearStartAttempt() {
    this.startPromise = undefined;
    this.resolveFirstStart = undefined;
    this.rejectFirstStart = undefined;
  }

  private takePendingCapture(requestId: string) {
    const pending = this.pendingCaptures.get(requestId);
    if (pending === undefined) return undefined;
    this.pendingCaptures.delete(requestId);
    clearTimeout(pending.timer);
    return pending;
  }

  private rejectPendingCaptures(error: Error) {
    for (const requestId of [...this.pendingCaptures.keys()]) {
      this.takePendingCapture(requestId)?.reject(error);
    }
  }

  private failChild(child: ChildProcessWithoutNullStreams, error: Error) {
    if (child !== this.child) return;
    this.handleExit(child, error);
    if (child.exitCode === null) child.kill();
  }
}
