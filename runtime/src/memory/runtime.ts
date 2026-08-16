import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { promisify } from "node:util";

import {
  JsonlSessionRepo,
  type JsonlSessionMetadata,
} from "@earendil-works/pi-agent-core";
import type { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { Model, Models } from "@earendil-works/pi-ai";

import { projectPendingMemoryArtifacts } from "./artifact-projector.js";
import { processNextChronicle } from "./chronicle/processor.js";
import { ChronicleRepository } from "./chronicle/repository.js";
import type { ChronicleFrameInput } from "./chronicle/types.js";
import type { MemoryConfig } from "./config.js";
import {
  processConsolidation,
  recoverConsolidationPublication,
} from "./consolidate/processor.js";
import { ConsolidationRepository } from "./consolidate/repository.js";
import { openMemoryDatabase, type MemoryDatabase } from "./database.js";
import { collectMemoryGarbage } from "./retention.js";
import { processNextTurnMemory } from "./turn-memory/processor.js";
import { TurnMemoryRepository } from "./turn-memory/repository.js";
import { scanTurnMemorySession } from "./turn-memory/session-scanner.js";

const execFileAsync = promisify(execFile);

export interface MemoryRuntimeDiagnostic {
  phase:
    | "start"
    | "chronicle"
    | "scan"
    | "worker"
    | "projection"
    | "consolidation"
    | "retention"
    | "stop";
  message: string;
}

export interface ChronicleFrameFeedRead {
  generationId: string;
  frames: ChronicleFrameInput[];
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
  private database?: MemoryDatabase;
  private repository?: TurnMemoryRepository;
  private chronicleRepository?: ChronicleRepository;
  private consolidationRepository?: ConsolidationRepository;
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
    this.options.onDiagnostic?.({ phase, message: errorMessage(error) });
  }

  private async branch(): Promise<string> {
    return this.options.gitBranch?.() ?? currentGitBranch(this.options.cwd);
  }

  private requireRepository(): TurnMemoryRepository {
    if (this.repository === undefined) throw new Error("Turn Memory is not started");
    return this.repository;
  }

  private requireChronicleRepository(): ChronicleRepository {
    if (this.chronicleRepository === undefined) {
      throw new Error("Chronicle Memory is not started");
    }
    return this.chronicleRepository;
  }

  private async projectPendingArtifacts(): Promise<void> {
    const repositories = [
      this.requireRepository(),
      this.requireChronicleRepository(),
    ];
    for (const repository of repositories) {
      await projectPendingMemoryArtifacts(
        this.options.memoryRoot,
        repository,
        this.now(),
      );
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
    const repository = this.requireChronicleRepository();
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
      if (repository.generationComplete(generation.generationId)) continue;
      const requestedCursor = repository.generationCursor(generation.generationId);
      const read = await feed.readFramesAfter(
        generation.generationId,
        requestedCursor,
        1_000,
      );
      if (read.generationId !== generation.generationId) {
        throw new Error("Chronicle frame feed changed generation");
      }
      this.validateFeedRead(read, requestedCursor);
      for (const frame of read.frames) repository.ingest(frame, this.now());
      if (!repository.advanceGenerationCursor(
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
        !repository.completeGeneration(read.generationId, read.cursor, this.now())
      ) {
        throw new Error("Chronicle generation completion ownership lost");
      }
      return;
    }
  }

  chronicleGenerationComplete(generationId: string): boolean {
    if (!this.config.enabled) return true;
    return this.chronicleRepository?.generationComplete(generationId) ?? false;
  }

  private async scanMetadata(
    metadata: JsonlSessionMetadata,
    branch: string,
  ): Promise<void> {
    const repository = this.requireRepository();
    const version = await fileVersion(metadata);
    if (!repository.shouldScan(metadata.id, version)) return;
    const result = await scanTurnMemorySession({
      session: await this.repo.open(metadata),
      fileVersion: version,
      gitBranch: branch,
      repository,
      scannedAt: this.now(),
    });
    if (result.status === "failed") {
      this.diagnostic("scan", new Error(result.error));
    }
  }

  private async scanAll(): Promise<void> {
    const branch = await this.branch();
    const sessions = await this.repo.list({ cwd: this.options.cwd });
    this.requireRepository().reconcileSessions(
      sessions.map(({ id }) => id),
      this.now(),
    );
    for (const metadata of sessions) {
      try {
        await this.scanMetadata(metadata, branch);
      } catch (error) {
        this.diagnostic("scan", error);
      }
    }
  }

  private async cycle(pollFrameFeed = true): Promise<void> {
    const repository = this.requireRepository();
    try {
      await this.projectPendingArtifacts();
    } catch (error) {
      this.diagnostic("projection", error);
    }
    if (pollFrameFeed) {
      try {
        await this.pollChronicleFrames();
      } catch (error) {
        this.diagnostic("chronicle", error);
      }
    }
    await this.scanAll();
    repository.sealDueBatches(this.now());
    let processedProducer = false;
    const chronicleRepository = this.requireChronicleRepository();
    for (let index = 0; index < this.config.worker.maxJobsPerTick; index += 1) {
      const result = await processNextChronicle({
        repository: chronicleRepository,
        models: this.options.models,
        model: this.options.model,
        workerId: "chronicle-memory-worker",
        memoryRoot: this.options.memoryRoot,
        now: this.now,
      });
      if (result.status === "no_job") break;
      if (result.status === "failed") {
        this.diagnostic("chronicle", new Error(result.error));
      } else {
        processedProducer = true;
        if (result.projectionError !== undefined) {
          this.diagnostic("projection", new Error(result.projectionError));
        }
      }
    }
    for (let index = 0; index < this.config.worker.maxJobsPerTick; index += 1) {
      const result = await processNextTurnMemory({
        repository,
        models: this.options.models,
        model: this.options.model,
        workerId: "turn-memory-worker",
        memoryRoot: this.options.memoryRoot,
        now: this.now,
      });
      if (result.status === "no_job") break;
      if (result.status === "failed") {
        this.diagnostic("worker", new Error(result.error));
      } else {
        processedProducer = true;
        if (result.projectionError !== undefined) {
          this.diagnostic("projection", new Error(result.projectionError));
        }
      }
    }
    if (!processedProducer && this.consolidationRepository !== undefined) {
      const result = await processConsolidation({
        root: this.options.memoryRoot,
        repository: this.consolidationRepository,
        models: this.options.models,
        model: this.options.model,
        workerId: "global-memory-worker",
        now: this.now,
        projectNewerSources: async () => {
          await this.projectPendingArtifacts();
        },
      });
      if (result.status === "failed") {
        this.diagnostic("consolidation", new Error(result.error));
      }
    }
    if (this.database !== undefined) {
      try {
        await collectMemoryGarbage({
          root: this.options.memoryRoot,
          database: this.database,
          config: this.config,
          now: this.now(),
        });
      } catch (error) {
        this.diagnostic("retention", error);
      }
    }
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    if (!this.config.enabled) return;
    try {
      this.database = openMemoryDatabase(this.options.memoryRoot);
      this.repository = new TurnMemoryRepository(this.database, {
        ...this.config.turnMemory,
        worker: {
          leaseMilliseconds: this.config.worker.leaseMilliseconds,
          retryDelayMilliseconds: this.config.worker.retryDelayMilliseconds,
          maxAttempts: this.config.worker.maxAttempts,
        },
      });
      this.chronicleRepository = new ChronicleRepository(this.database, {
        ...this.config.chronicle,
        worker: {
          leaseMilliseconds: this.config.worker.leaseMilliseconds,
          retryDelayMilliseconds: this.config.worker.retryDelayMilliseconds,
          maxAttempts: this.config.worker.maxAttempts,
        },
      });
      this.consolidationRepository = new ConsolidationRepository(
        this.database,
        this.config,
      );
      await recoverConsolidationPublication({
        root: this.options.memoryRoot,
        repository: this.consolidationRepository,
        now: this.now,
        projectNewerSources: async () => {
          await this.projectPendingArtifacts();
        },
      });
      try {
        await this.projectPendingArtifacts();
      } catch (error) {
        this.diagnostic("projection", error);
      }
      this.interval = setInterval(() => {
        void this.runOnce().catch((error) => this.diagnostic("worker", error));
      }, this.config.worker.intervalMilliseconds);
      this.interval.unref();
    } catch (error) {
      this.database?.close();
      this.database = undefined;
      this.repository = undefined;
      this.chronicleRepository = undefined;
      this.consolidationRepository = undefined;
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
      this.database?.close();
      this.database = undefined;
      this.repository = undefined;
      this.chronicleRepository = undefined;
      this.consolidationRepository = undefined;
      this.started = false;
    }
  }
}
