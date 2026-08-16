import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { Recorder, type RecorderOptions } from "@screenpipe/sdk";

import {
  openScreenpipeDatabase,
  type ScreenpipeDatabase,
  type ScreenpipeFrameBatch,
} from "./database.js";
import type { ScreenFrameSource } from "./frame-source.js";
import {
  ScreenpipeGenerationStore,
  type GenerationRetentionPolicy,
  type GenerationStoreDiagnostic,
  validateGenerationId,
} from "./generation-store.js";
import {
  buildScreenpipeRecorderOptions,
  SCREENPIPE_TELEMETRY_ENV,
} from "./recorder.js";

export type ScreenpipeRecorder = {
  start(): Promise<void>;
  stop(): Promise<void>;
};

export type ScreenpipeGeneration = {
  generationId: string;
  generationRoot: string;
};

export type ScreenpipeCaptureSnapshot = {
  generation: ScreenpipeGeneration;
  frames: ScreenFrameSource[];
};

export type ScreenpipeFrameRead = ScreenpipeFrameBatch & {
  generation: ScreenpipeGeneration;
};

export type ScreenpipeGenerationStatus = {
  generationId: string;
  active: boolean;
};

export type ScreenpipeRuntimeOptions = {
  dataRoot: string;
  ignoredWindows: string[];
  ignoredUrls: string[];
  now?: () => Date;
  generationIdFactory?: () => string;
  environment?: NodeJS.ProcessEnv;
  recorderFactory?: (options: RecorderOptions) => ScreenpipeRecorder;
  databaseFactory?: (path: string, generationId: string) => ScreenpipeDatabase;
  generationPolicy?: GenerationRetentionPolicy;
  canDeleteGeneration?: (generationId: string) => boolean | Promise<boolean>;
  onDiagnostic?: (diagnostic: GenerationStoreDiagnostic | {
    phase: "generation-rotation";
    message: string;
  }) => void;
  timerFactory?: (callback: () => void, delayMilliseconds: number) => RotationTimer;
  timerClear?: (timer: RotationTimer) => void;
};

type StartedGeneration = ScreenpipeGeneration & {
  createdAtMs: number;
  recorder: ScreenpipeRecorder;
  database: ScreenpipeDatabase;
};

export type RotationTimer = {
  unref?: () => void;
};

function defaultGenerationId(now: Date): string {
  return `${now.toISOString().replaceAll(":", "-").replace(".", "-")}-${randomUUID()}`;
}

export class ScreenpipeRuntime {
  private readonly now: () => Date;
  private readonly makeGenerationId: () => string;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly recorderFactory: (options: RecorderOptions) => ScreenpipeRecorder;
  private readonly databaseFactory: (path: string, generationId: string) => ScreenpipeDatabase;
  private readonly generationStore: ScreenpipeGenerationStore;
  private readonly onDiagnostic?: ScreenpipeRuntimeOptions["onDiagnostic"];
  private readonly timerFactory: (callback: () => void, delayMilliseconds: number) => RotationTimer;
  private readonly timerClear: (timer: RotationTimer) => void;
  private lifecycle = Promise.resolve();
  private current?: StartedGeneration;
  private pendingCleanup?: StartedGeneration;
  private rotationTimer?: RotationTimer;
  private started = false;
  private unavailableError?: unknown;

  constructor(private readonly options: ScreenpipeRuntimeOptions) {
    this.now = options.now ?? (() => new Date());
    this.makeGenerationId = options.generationIdFactory ?? (() => defaultGenerationId(this.now()));
    this.environment = options.environment ?? process.env;
    this.recorderFactory = options.recorderFactory ?? ((recorderOptions) =>
      new Recorder(recorderOptions));
    this.databaseFactory = options.databaseFactory ?? openScreenpipeDatabase;
    this.onDiagnostic = options.onDiagnostic;
    this.generationStore = new ScreenpipeGenerationStore({
      dataRoot: options.dataRoot,
      policy: options.generationPolicy,
      now: this.now,
      canDeleteGeneration: options.canDeleteGeneration,
      onDiagnostic: (diagnostic) => this.onDiagnostic?.(diagnostic),
    });
    this.timerFactory = options.timerFactory ?? ((callback, delayMilliseconds) =>
      setTimeout(callback, delayMilliseconds));
    this.timerClear = options.timerClear ?? ((timer) => {
      clearTimeout(timer as NodeJS.Timeout);
    });
  }

  start(): Promise<void> {
    return this.enqueue(async () => {
      if (this.started) {
        if (this.current !== undefined) return;
        await this.retryUnavailableGeneration();
        return;
      }
      this.started = true;
      try {
        await this.retryPendingCleanup();
        await this.startGeneration();
      } catch (error) {
        this.started = false;
        throw error;
      }
    });
  }

  stop(): Promise<void> {
    return this.enqueue(async () => {
      this.started = false;
      this.clearRotationTimer();
      const current = this.current;
      const pending = this.pendingCleanup;
      this.current = undefined;
      this.pendingCleanup = undefined;
      this.unavailableError = undefined;
      let failure: unknown;
      if (current !== undefined) {
        try {
          await this.disposeGeneration(current);
        } catch (error) {
          this.pendingCleanup = current;
          failure = error;
        }
      }
      if (pending !== undefined && pending !== current) {
        try {
          await this.disposeGeneration(pending);
        } catch (error) {
          this.pendingCleanup = pending;
          failure ??= error;
        }
      }
      if (failure !== undefined) throw failure;
    });
  }

  rotate(): Promise<void> {
    return this.enqueue(async () => {
      if (!this.started) throw new Error("Screenpipe runtime has not started");
      await this.rotateGeneration();
    });
  }

  generation(): ScreenpipeGeneration {
    const current = this.current;
    if (current === undefined) {
      throw new Error("Screenpipe runtime has not started");
    }
    return {
      generationId: current.generationId,
      generationRoot: current.generationRoot,
    };
  }

  latestFrames(): ScreenFrameSource[] {
    const current = this.current;
    if (current === undefined) {
      throw new Error("Screenpipe runtime has not started");
    }
    return current.database.latestFrames();
  }

  captureSnapshot(): Promise<ScreenpipeCaptureSnapshot> {
    return this.enqueue(async () => {
      const current = await this.requireReadableGeneration();
      return {
        generation: {
          generationId: current.generationId,
          generationRoot: current.generationRoot,
        },
        frames: current.database.latestFrames().map((frame) => ({ ...frame })),
      };
    });
  }

  readFramesAfter(cursor: number, limit: number): Promise<ScreenpipeFrameRead> {
    return this.enqueue(async () => {
      const current = await this.requireReadableGeneration();
      const batch = current.database.framesAfter(cursor, limit);
      return {
        generation: {
          generationId: current.generationId,
          generationRoot: current.generationRoot,
        },
        frames: batch.frames.map((frame) => ({ ...frame })),
        cursor: batch.cursor,
        hasMore: batch.hasMore,
      };
    });
  }

  listGenerations(): Promise<ScreenpipeGenerationStatus[]> {
    return this.enqueue(async () => {
      const current = await this.requireReadableGeneration();
      const generations = await this.generationStore.listGenerations(
        current.generationRoot,
      );
      if (generations.filter(({ active }) => active).length !== 1) {
        throw new Error("Screenpipe active generation is unavailable");
      }
      return generations.map(({ generationId, active }) => ({
        generationId,
        active,
      }));
    });
  }

  readGenerationFramesAfter(
    generationId: string,
    cursor: number,
    limit: number,
  ): Promise<ScreenpipeFrameRead> {
    return this.enqueue(async () => {
      const id = validateGenerationId(generationId);
      const current = await this.requireReadableGeneration();
      const generation = (await this.generationStore.listGenerations(
        current.generationRoot,
      )).find((candidate) => candidate.generationId === id);
      if (generation === undefined) {
        throw new Error("Screenpipe generation is not available");
      }
      const database = generation.active
        ? current.database
        : this.databaseFactory(join(generation.generationRoot, "db.sqlite"), id);
      try {
        const batch = database.framesAfter(cursor, limit);
        return {
          generation: {
            generationId: id,
            generationRoot: generation.generationRoot,
          },
          frames: batch.frames.map((frame) => ({ ...frame })),
          cursor: batch.cursor,
          hasMore: batch.hasMore,
        };
      } finally {
        if (!generation.active) database.close();
      }
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.lifecycle.then(operation, operation);
    this.lifecycle = result.then(() => undefined, () => undefined);
    return result;
  }

  private async startGeneration(): Promise<void> {
    const stored = await this.generationStore.createGeneration(
      validateGenerationId(this.makeGenerationId()),
    );
    const { generationId: id, generationRoot } = stored;

    this.environment.SCREENPIPE_SDK_TELEMETRY = SCREENPIPE_TELEMETRY_ENV
      .SCREENPIPE_SDK_TELEMETRY;
    const recorder = this.recorderFactory(buildScreenpipeRecorderOptions({
      dataDir: generationRoot,
      ignoredWindows: this.options.ignoredWindows,
      ignoredUrls: this.options.ignoredUrls,
    }));
    let database: ScreenpipeDatabase | undefined;
    try {
      await recorder.start();
      database = this.databaseFactory(join(generationRoot, "db.sqlite"), id);
      this.current = {
        generationId: id,
        generationRoot,
        createdAtMs: stored.createdAtMs,
        recorder,
        database,
      };
      this.unavailableError = undefined;
      this.scheduleRotationTimer(this.current);
      await this.generationStore.retain(generationRoot);
    } catch (error) {
      if (this.current?.recorder === recorder) {
        this.current = undefined;
      }
      this.clearRotationTimer();
      try {
        await recorder.stop();
      } catch {
        // Preserve the startup error after a best-effort native cleanup.
      }
      try {
        database?.close();
      } catch {
        // Preserve the startup error after a best-effort reader cleanup.
      }
      throw error;
    }
  }

  private async requireReadableGeneration(): Promise<StartedGeneration> {
    if (!this.started) throw new Error("Screenpipe runtime has not started");
    const current = this.current;
    if (current === undefined) {
      throw this.unavailableError ?? new Error("Screenpipe runtime has not started");
    }
    if (this.isExpired(current)) {
      await this.rotateGeneration();
      if (this.current === undefined) {
        throw this.unavailableError ?? new Error("Screenpipe generation is unavailable");
      }
      return this.current;
    }
    return current;
  }

  private isExpired(current: StartedGeneration): boolean {
    const now = this.now();
    return now.getTime() >= current.createdAtMs + this.generationStore.policy.maxAgeMilliseconds
      || utcDay(now) !== utcDay(new Date(current.createdAtMs));
  }

  private async rotateGeneration(): Promise<void> {
    this.clearRotationTimer();
    const old = this.current;
    this.current = undefined;
    this.unavailableError = undefined;
    if (old !== undefined) {
      try {
        await this.disposeGeneration(old);
      } catch (error) {
        this.pendingCleanup = old;
        this.unavailableError = error;
        this.reportRotationFailure(error);
        throw error;
      }
    }
    try {
      await this.retryPendingCleanup();
      await this.startGeneration();
    } catch (error) {
      this.unavailableError = error;
      this.reportRotationFailure(error);
      throw error;
    }
  }

  private async retryUnavailableGeneration(): Promise<void> {
    this.unavailableError = undefined;
    try {
      await this.retryPendingCleanup();
      await this.startGeneration();
    } catch (error) {
      this.unavailableError = error;
      throw error;
    }
  }

  private async retryPendingCleanup(): Promise<void> {
    const pending = this.pendingCleanup;
    if (pending === undefined) return;
    await this.disposeGeneration(pending);
    this.pendingCleanup = undefined;
  }

  private async disposeGeneration(generation: StartedGeneration): Promise<void> {
    try {
      await generation.recorder.stop();
    } finally {
      generation.database.close();
    }
  }

  private scheduleRotationTimer(current: StartedGeneration): void {
    const nowMs = this.now().getTime();
    const now = new Date(nowMs);
    const nextUtcDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
    const ageDeadline = current.createdAtMs + this.generationStore.policy.maxAgeMilliseconds;
    const delay = Math.max(1, Math.min(nextUtcDay, ageDeadline) - nowMs);
    const timer = this.timerFactory(() => {
      this.rotationTimer = undefined;
      void this.enqueue(async () => {
        if (!this.started || this.current === undefined) return;
        if (this.isExpired(this.current)) await this.rotateGeneration();
        else this.scheduleRotationTimer(this.current);
      }).catch((error) => {
        this.unavailableError = error;
        this.reportRotationFailure(error);
      });
    }, delay);
    timer.unref?.();
    this.rotationTimer = timer;
  }

  private clearRotationTimer(): void {
    if (this.rotationTimer === undefined) return;
    this.timerClear(this.rotationTimer);
    this.rotationTimer = undefined;
  }

  private reportRotationFailure(_error: unknown): void {
    try {
      this.onDiagnostic?.({
        phase: "generation-rotation",
        message: "Generation rotation failed",
      });
    } catch {
      // Diagnostics cannot alter lifecycle state.
    }
  }
}

function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}
