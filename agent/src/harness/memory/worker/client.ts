import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";

import type { ScreenObservation } from "../../../extensions/screen-observation/types.js";
import { openMemoryDatabase } from "../db/database.js";
import type {
  MemoryWorkerCommand,
  MemoryWorkerData,
  MemoryWorkerResponse,
  MemoryWorkerRole,
} from "./messages.js";

const WORKER_ROLES = ["chronicle", "turnMemory", "consolidation"] as const;
type MemoryWorkerClientData = Omit<MemoryWorkerData, "role">;

class RoleWorkerClient {
  readonly worker: Worker;
  private readonly readyPromise: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private readonly pending = new Map<string, {
    resolve: () => void;
    reject: (error: Error) => void;
  }>();
  private stopped = false;
  private stopping = false;
  private stopPromise?: Promise<void>;
  private terminalError?: Error;

  constructor(readonly role: MemoryWorkerRole, data: MemoryWorkerClientData) {
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.worker = new Worker(new URL("./thread.js", import.meta.url), {
      workerData: { ...data, role } satisfies MemoryWorkerData,
    });
    this.worker.on("message", (message: MemoryWorkerResponse) => {
      if (message.type === "ready") {
        this.resolveReady();
        return;
      }
      if (message.type === "error" && !message.requestId) {
        process.stderr.write(
          `OpenScreen ${role} memory worker failed: ${message.message}\n`,
        );
        return;
      }
      if (!("requestId" in message) || !message.requestId) return;
      const pending = this.pending.get(message.requestId);
      if (!pending) return;
      this.pending.delete(message.requestId);
      if (message.type === "error") pending.reject(new Error(message.message));
      else pending.resolve();
    });
    this.worker.on("error", (cause) => {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      this.handleUnexpectedStop(error);
    });
    this.worker.on("exit", (code) => {
      if (this.stopped) return;
      this.handleUnexpectedStop(new Error(
        code === 0
          ? `Memory worker exited unexpectedly (${role})`
          : `Memory worker exited with code ${code} (${role})`,
      ));
    });
  }

  private handleUnexpectedStop(error: Error) {
    if (this.stopped) return;
    this.stopped = true;
    this.stopping = false;
    this.terminalError = error;
    this.rejectReady(error);
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }

  get threadId() {
    return this.worker.threadId;
  }

  ready() {
    return this.readyPromise;
  }

  async request(message: MemoryWorkerCommand, allowStopping = false) {
    await this.readyPromise;
    if (this.stopped || (this.stopping && !allowStopping)) {
      throw this.terminalError ?? new Error(`${this.role} Memory worker is stopped`);
    }
    const requestId = randomUUID();
    const completed = new Promise<void>((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
    });
    this.worker.postMessage({ ...message, requestId });
    return completed;
  }

  stop() {
    this.stopPromise ??= this.stopNow();
    return this.stopPromise;
  }

  private async stopNow() {
    if (this.stopped) return;
    await this.readyPromise.catch(() => {});
    if (this.worker.threadId < 0) {
      this.stopped = true;
      return;
    }
    this.stopping = true;
    try {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        this.request({ type: "shutdown" }, true),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 5_000);
          timer.unref();
        }),
      ]);
      if (timer) clearTimeout(timer);
    } finally {
      this.stopped = true;
      await this.worker.terminate();
      const error = new Error(`${this.role} Memory worker stopped`);
      for (const request of this.pending.values()) request.reject(error);
      this.pending.clear();
    }
  }
}

export class MemoryWorkerClient {
  private readonly roleWorkers: Record<MemoryWorkerRole, RoleWorkerClient>;
  private readonly worker: Worker;
  private stopPromise?: Promise<void>;

  constructor(data: MemoryWorkerClientData) {
    openMemoryDatabase(data.memoryRoot).close();
    this.roleWorkers = Object.fromEntries(WORKER_ROLES.map((role) => [
      role,
      new RoleWorkerClient(role, data),
    ])) as Record<MemoryWorkerRole, RoleWorkerClient>;
    this.worker = this.roleWorkers.chronicle.worker;
  }

  get threadId() {
    return this.roleWorkers.chronicle.threadId;
  }

  get threadIds() {
    return Object.fromEntries(WORKER_ROLES.map((role) => [
      role,
      this.roleWorkers[role].threadId,
    ])) as Record<MemoryWorkerRole, number>;
  }

  async ready() {
    await Promise.all(WORKER_ROLES.map((role) => this.roleWorkers[role].ready()));
  }

  recordObservation(observation: ScreenObservation) {
    return this.roleWorkers.chronicle.request({ type: "observation", observation });
  }

  scanSession(sessionId: string) {
    return this.roleWorkers.turnMemory.request({ type: "session", sessionId });
  }

  async tick() {
    await Promise.all(WORKER_ROLES.map((role) => (
      this.roleWorkers[role].request({ type: "tick" })
    )));
  }

  stop() {
    this.stopPromise ??= this.stopNow();
    return this.stopPromise;
  }

  private async stopNow() {
    await Promise.all(WORKER_ROLES.map((role) => this.roleWorkers[role].stop()));
  }
}
