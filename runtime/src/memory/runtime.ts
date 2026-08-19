import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { promisify } from "node:util";

import {
  JsonlSessionRepo,
  type JsonlSessionMetadata,
} from "@earendil-works/pi-agent-core";
import type { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { Model, Models } from "@earendil-works/pi-ai";

import { summarizeChronicleWindow } from "./chronicle/processor.js";
import type { MemoryConfig } from "./config.js";
import { openMemoryCursors, type MemoryCursors } from "./cursors.js";
import { appendMemoryDiagnostic } from "./diagnostics-log.js";
import { createMemoryProjector, type MemoryProjector } from "./mastra/projector.js";
import { openMastraMemoryStore, type MastraMemoryStore } from "./mastra/store.js";
import { recordInteractiveTurn, type WritePathDeps } from "./mastra/write-path.js";
import { scanTurnMemorySession } from "./turn-memory/session-scanner.js";
import { renderTurnRollout } from "./turn-memory/rollout.js";

const execFileAsync = promisify(execFile);

export interface MemoryRuntimeDiagnostic {
  phase: "start" | "chronicle" | "scan" | "worker" | "projection" | "retention" | "stop";
  message: string;
}

export interface ChronicleFrameFeedRead {
  generationId: string;
  frames: Array<{
    sourceId: string;
    generationId: string;
    frameId: string;
    monitorKey: string;
    deviceName: string;
    capturedAt: string;
    trigger: string;
    application?: string;
    windowTitle?: string;
    url?: string;
    visibleText?: string;
  }>;
  cursor: number;
  hasMore: boolean;
}

export interface ChronicleFrameFeedGeneration {
  generationId: string;
  active: boolean;
}

export interface ChronicleFrameFeed {
  listGenerations(): Promise<ChronicleFrameFeedGeneration[]>;
  readFramesAfter(
    generationId: string,
    cursor: number,
    limit: number,
  ): Promise<ChronicleFrameFeedRead>;
}

export interface MemoryRuntimeOptions {
  cwd: string;
  sessionsRoot: string;
  memoryRoot: string;
  env: NodeExecutionEnv;
  models: Models;
  model: Model<string>;
  agent: { provider: string; model: string };
  config: MemoryConfig;
  chronicleFrameFeed?: ChronicleFrameFeed;
  gitBranch?: () => string | Promise<string>;
  now?: () => number;
  onDiagnostic?: (diagnostic: MemoryRuntimeDiagnostic) => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function currentGitBranch(cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["branch", "--show-current"], {
      cwd,
      encoding: "utf8",
    });
    return stdout.trim() || "detached";
  } catch {
    return "unknown";
  }
}

async function fileVersion(metadata: JsonlSessionMetadata): Promise<string> {
  const info = await stat(metadata.path);
  return `${info.size}:${info.mtimeMs}`;
}

export class MemoryRuntime {
  readonly config: MemoryConfig;
  private readonly now: () => number;
  private readonly repo: JsonlSessionRepo;
  private cursors?: MemoryCursors;
  private mastraStore?: MastraMemoryStore;
  private projector?: MemoryProjector;
  private interval?: NodeJS.Timeout;
  private tail: Promise<void> = Promise.resolve();
  private started = false;

  constructor(private readonly options: MemoryRuntimeOptions) {
    this.config = options.config;
    this.now = options.now ?? Date.now;
    this.repo = new JsonlSessionRepo({
      fs: options.env,
      sessionsRoot: options.sessionsRoot,
    });
  }

  private diagnostic(
    phase: MemoryRuntimeDiagnostic["phase"],
    error: unknown,
  ): void {
    const message = errorMessage(error);
    // The full message goes to the private diagnostics log; the callback
    // (wired to stderr at the composition root) intentionally stays
    // content-free. See diagnostics-log.ts for why they differ.
    appendMemoryDiagnostic(this.options.memoryRoot, phase, message, this.now());
    this.options.onDiagnostic?.({ phase, message });
  }

  private async branch(): Promise<string> {
    return this.options.gitBranch?.() ?? currentGitBranch(this.options.cwd);
  }

  private requireCursors(): MemoryCursors {
    if (this.cursors === undefined) throw new Error("Memory is not started");
    return this.cursors;
  }

  private requireMastraStore(): MastraMemoryStore {
    if (this.mastraStore === undefined) throw new Error("Memory is not started");
    return this.mastraStore;
  }

  private requireProjector(): MemoryProjector {
    if (this.projector === undefined) throw new Error("Memory is not started");
    return this.projector;
  }

  private writePathDeps(): WritePathDeps {
    return { store: this.requireMastraStore(), projector: this.requireProjector() };
  }

  chronicleGenerationComplete(generationId: string): boolean {
    if (!this.config.enabled) return true;
    return this.cursors?.chronicleGenerationComplete(generationId) ?? false;
  }

  private async scanMetadata(
    metadata: JsonlSessionMetadata,
    branch: string,
  ): Promise<void> {
    const cursors = this.requireCursors();
    const version = await fileVersion(metadata);
    if (!cursors.shouldScanSession(metadata.id, version)) return;
    const result = await scanTurnMemorySession({
      session: await this.repo.open(metadata),
      fileVersion: version,
      gitBranch: branch,
      cursors,
      onTerminalSource: async (source) => {
        const rollout = renderTurnRollout(source, this.now());
        await recordInteractiveTurn(this.writePathDeps(), rollout.observationText, {
          relativePath: rollout.relativePath,
          content: rollout.content,
        });
      },
      scannedAt: this.now(),
    });
    if (result.status === "failed") {
      this.diagnostic("scan", new Error(result.error));
    }
  }

  private async scanAll(): Promise<void> {
    const branch = await this.branch();
    const sessions = await this.repo.list({ cwd: this.options.cwd });
    for (const metadata of sessions) {
      try {
        await this.scanMetadata(metadata, branch);
      } catch (error) {
        this.diagnostic("scan", error);
      }
    }
  }

  private validateFeedRead(
    read: ChronicleFrameFeedRead,
    requestedCursor: number,
  ): void {
    if (
      !read.generationId.trim() ||
      !Number.isSafeInteger(read.cursor) ||
      read.cursor < requestedCursor ||
      typeof read.hasMore !== "boolean" ||
      !Array.isArray(read.frames)
    ) {
      throw new Error("Invalid Chronicle frame feed result");
    }
    const sourceIds = new Set<string>();
    for (const frame of read.frames) {
      const frameId = Number(frame.frameId);
      if (
        frame.generationId !== read.generationId ||
        !Number.isSafeInteger(frameId) ||
        frameId <= requestedCursor ||
        frameId > read.cursor ||
        sourceIds.has(frame.sourceId)
      ) {
        throw new Error("Invalid Chronicle frame feed source");
      }
      sourceIds.add(frame.sourceId);
    }
  }

  private async pollChronicleFrames(): Promise<void> {
    const feed = this.options.chronicleFrameFeed;
    if (feed === undefined) return;
    const cursors = this.requireCursors();
    const generations = await feed.listGenerations();
    const seen = new Set<string>();
    let activeCount = 0;
    for (const generation of generations) {
      if (
        !generation.generationId.trim() ||
        typeof generation.active !== "boolean" ||
        seen.has(generation.generationId)
      ) {
        throw new Error("Invalid Chronicle generation feed");
      }
      seen.add(generation.generationId);
      if (generation.active) activeCount += 1;
    }
    if (generations.length > 0 && activeCount !== 1) {
      throw new Error("Invalid Chronicle active generation feed");
    }
    for (const generation of generations) {
      if (cursors.chronicleGenerationComplete(generation.generationId)) continue;
      const requestedCursor = cursors.chronicleGenerationCursor(generation.generationId);
      const read = await feed.readFramesAfter(generation.generationId, requestedCursor, 1_000);
      if (read.generationId !== generation.generationId) {
        throw new Error("Chronicle frame feed changed generation");
      }
      this.validateFeedRead(read, requestedCursor);
      for (const frame of read.frames) {
        cursors.ingestChronicleFrame(frame, this.config.chronicle, this.now());
      }
      if (!cursors.advanceChronicleGenerationCursor(
        read.generationId,
        requestedCursor,
        read.cursor,
        this.now(),
      )) {
        throw new Error("Chronicle ingest cursor ownership lost");
      }
      if (
        !generation.active &&
        !read.hasMore &&
        !cursors.completeChronicleGeneration(read.generationId, read.cursor, this.now())
      ) {
        throw new Error("Chronicle generation completion ownership lost");
      }
      return;
    }
  }

  private async summarizeDueChronicleWindows(): Promise<void> {
    const cursors = this.requireCursors();
    const due = cursors.dueChronicleWindows(this.now());
    for (const window of due.slice(0, this.config.worker.maxChronicleWindowsPerTick)) {
      const frames = cursors.loadChronicleWindowFrames(window.windowId);
      if (frames.length === 0) continue;
      cursors.recordChronicleWindowAttempt(window.windowId);
      const result = await summarizeChronicleWindow({
        windowId: window.windowId,
        frames,
        policy: this.config.chronicle,
        models: this.options.models,
        model: this.options.model,
        writePath: this.writePathDeps(),
        now: this.now,
      });
      if (result.status === "failed") {
        this.diagnostic("chronicle", new Error(result.error));
        continue;
      }
      cursors.markChronicleWindowSummarized(window.windowId, this.now());
    }
  }

  private async cycle(pollFrameFeed = true): Promise<void> {
    if (pollFrameFeed) {
      try {
        await this.pollChronicleFrames();
      } catch (error) {
        this.diagnostic("chronicle", error);
      }
    }
    await this.scanAll();
    try {
      await this.summarizeDueChronicleWindows();
    } catch (error) {
      this.diagnostic("chronicle", error);
    }
    try {
      await this.requireProjector().projectObservationLogs();
    } catch (error) {
      this.diagnostic("projection", error);
    }
    try {
      await this.requireProjector().pruneChronicleRollouts(
        this.config.retention.chronicleRolloutMaxAgeMilliseconds,
        this.now(),
      );
    } catch (error) {
      this.diagnostic("retention", error);
    }
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    if (!this.config.enabled) return;
    try {
      this.cursors = openMemoryCursors(this.options.memoryRoot);
      this.mastraStore = openMastraMemoryStore(
        this.options.memoryRoot,
        this.config,
        this.options.agent,
      );
      this.projector = createMemoryProjector(this.options.memoryRoot, this.mastraStore);
      try {
        await this.projector.projectObservationLogs();
      } catch (error) {
        this.diagnostic("projection", error);
      }
      this.interval = setInterval(() => {
        void this.runOnce().catch((error) => this.diagnostic("worker", error));
      }, this.config.worker.intervalMilliseconds);
      this.interval.unref();
    } catch (error) {
      await this.mastraStore?.close().catch(() => {});
      this.cursors?.close();
      this.cursors = undefined;
      this.mastraStore = undefined;
      this.projector = undefined;
      this.started = false;
      this.diagnostic("start", error);
      throw error;
    }
  }

  runOnce(): Promise<void> {
    if (!this.started || !this.config.enabled) return Promise.resolve();
    const operation = this.tail.then(() => this.cycle());
    this.tail = operation.catch(() => undefined);
    return operation;
  }

  notifySession(sessionId: string): Promise<void> {
    if (!this.started || !this.config.enabled) return Promise.resolve();
    const operation = this.tail.then(async () => {
      const metadata = (await this.repo.list({ cwd: this.options.cwd })).find(
        (candidate) => candidate.id === sessionId,
      );
      if (metadata === undefined) return;
      await this.scanMetadata(metadata, await this.branch());
    });
    this.tail = operation.catch((error) => {
      this.diagnostic("scan", error);
    });
    return this.tail;
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    if (this.interval !== undefined) clearInterval(this.interval);
    this.interval = undefined;
    try {
      await this.tail;
    } catch (error) {
      this.diagnostic("stop", error);
    } finally {
      await this.mastraStore?.close().catch(() => {});
      this.cursors?.close();
      this.cursors = undefined;
      this.mastraStore = undefined;
      this.projector = undefined;
      this.started = false;
    }
  }
}
