import { setImmediate as yieldToEventLoop } from "node:timers/promises";

import type OpenAI from "openai";

import { processNextChronicle } from "../chronicle/processor.js";
import { ChronicleRepository } from "../chronicle/repository.js";
import { processConsolidation } from "../consolidate/processor.js";
import { ConsolidationRepository } from "../consolidate/repository.js";
import { openMemoryDatabase, type MemoryDatabase } from "../db/database.js";
import {
  cleanupEvidence,
  persistObservationEvidence,
  type ObservationEvidence,
} from "../evidence.js";
import { countModelRequestTokens } from "../shared/model-request.js";
import { turnMemoryInputTokenBudget } from "../shared/request-budget.js";
import { buildTurnMemoryExtractionRequest } from "../turn-memory/extractor.js";
import { processNextTurnMemory } from "../turn-memory/processor.js";
import { TurnMemoryRepository } from "../turn-memory/repository.js";
import { loadSessionTurnMemorySources } from "../turn-memory/session-scanner.js";
import { SessionScanRepository } from "../turn-memory/session-scan-repository.js";
import type { TurnMemorySource } from "../turn-memory/types.js";
import { listSessions } from "../../session/store.js";
import type { ScreenObservation } from "../../../extensions/screen-observation/types.js";
import type { MemoryPipelineConfig } from "../types.js";

export type MemoryPipelineOptions = {
  memoryRoot: string;
  sessionsDirectory: string;
  client: OpenAI;
  model: string;
  workerId: string;
  contextWindowTokens: number;
  memory: MemoryPipelineConfig;
  persistObservationEvidence?: (
    root: string,
    observation: ScreenObservation,
  ) => Promise<ObservationEvidence>;
  now?: () => number;
};

export type CapturedSessionSources = {
  sessionId: string;
  sessionUpdatedAt: string;
  includesInterrupted: boolean;
  sources: TurnMemorySource[];
};

export class MemoryPipeline {
  readonly database: MemoryDatabase;
  private readonly chronicle: ChronicleRepository;
  private readonly turnMemory: TurnMemoryRepository;
  private readonly consolidation: ConsolidationRepository;
  private readonly sessionScans: SessionScanRepository;
  private readonly now: () => number;
  private scanQueue: Promise<void> = Promise.resolve();
  private evidenceQueue: Promise<void> = Promise.resolve();

  constructor(private readonly options: MemoryPipelineOptions) {
    this.database = openMemoryDatabase(options.memoryRoot);
    this.chronicle = new ChronicleRepository(this.database, options.memory);
    this.turnMemory = new TurnMemoryRepository(this.database, options.memory);
    this.consolidation = new ConsolidationRepository(this.database, options.memory);
    this.sessionScans = new SessionScanRepository(this.database);
    this.now = options.now ?? Date.now;
  }

  async ingestObservation(observation: ScreenObservation) {
    return this.withEvidenceLock(async () => {
      const persist = this.options.persistObservationEvidence ?? persistObservationEvidence;
      const evidence = await persist(this.options.memoryRoot, observation);
      return this.chronicle.ingestObservation(observation, this.now(), evidence);
    });
  }

  private withEvidenceLock<T>(operation: () => Promise<T>) {
    const result = this.evidenceQueue.then(operation);
    this.evidenceQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private turnInputBudget() {
    return turnMemoryInputTokenBudget({
      contextWindowTokens: this.options.contextWindowTokens,
      maxInputTokens: this.options.memory.turnMemory.maxInputTokens,
      maxOutputTokens: this.options.memory.turnMemory.maxOutputTokens,
    });
  }

  private async ingestSessionSources(
    sessionId: string,
    sources: TurnMemorySource[],
    signal?: AbortSignal,
  ) {
    const inputBudget = this.turnInputBudget();
    for (const source of sources) {
      if (signal?.aborted) throw signal.reason ?? new Error("Session scan aborted");
      while (true) {
        const projection = this.turnMemory.previewBatch(sessionId, source, inputBudget);
        if (!projection) break;
        const request = buildTurnMemoryExtractionRequest(
          this.options.model,
          projection,
          this.options.memory.turnMemory.maxOutputTokens,
        );
        const projectedInputTokens = await countModelRequestTokens(
          this.options.client,
          request,
          signal,
        );
        const result = this.turnMemory.ingestTurn({
          sessionId,
          source,
          projectedInputTokens,
          maxInputTokens: inputBudget,
          ingestedAt: this.now(),
        });
        if (result.accepted) break;
      }
    }
    return sources.length;
  }

  private enqueueScan<T>(operation: () => Promise<T>) {
    const scan = this.scanQueue.then(operation);
    this.scanQueue = scan.then(() => undefined, () => undefined);
    return scan;
  }

  scanSession(
    sessionId: string,
    { includeInterrupted = false, signal }: {
      includeInterrupted?: boolean;
      signal?: AbortSignal;
    } = {},
  ) {
    return this.enqueueScan(async () => {
      const sources = await loadSessionTurnMemorySources(
        this.options.sessionsDirectory,
        sessionId,
        { includeInterrupted },
      );
      return this.ingestSessionSources(sessionId, sources, signal);
    });
  }

  async captureSessionSources(
    { includeInterrupted = false }: { includeInterrupted?: boolean } = {},
  ) {
    const sessions = await listSessions(this.options.sessionsDirectory, {
      reportInvalid: false,
    });
    const captured: CapturedSessionSources[] = [];
    for (const session of sessions) {
      if (!this.sessionScans.shouldScan(
        session.id,
        session.updatedAt,
        includeInterrupted,
      )) continue;
      try {
        const sources = await loadSessionTurnMemorySources(
          this.options.sessionsDirectory,
          session.id,
          { includeInterrupted },
        );
        captured.push({
          sessionId: session.id,
          sessionUpdatedAt: session.updatedAt,
          includesInterrupted: includeInterrupted,
          sources,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "unknown error";
        this.sessionScans.recordFailure(
          session.id,
          session.updatedAt,
          message,
          this.now(),
        );
        process.stderr.write(
          `Turn Memory skipped Session ${session.id}: ${message}\n`,
        );
      }
    }
    return captured;
  }

  ingestCapturedSessions(captured: CapturedSessionSources[], signal?: AbortSignal) {
    return this.enqueueScan(async () => {
      let count = 0;
      for (const session of captured) {
        count += await this.ingestSessionSources(session.sessionId, session.sources, signal);
        this.sessionScans.recordSuccess(
          session.sessionId,
          session.sessionUpdatedAt,
          session.includesInterrupted,
          this.now(),
        );
      }
      return count;
    });
  }

  async scanSessions({
    includeInterrupted = false,
    signal,
  }: { includeInterrupted?: boolean; signal?: AbortSignal } = {}) {
    return this.ingestCapturedSessions(
      await this.captureSessionSources({ includeInterrupted }),
      signal,
    );
  }

  async tickChronicle(signal?: AbortSignal) {
    let chronicleJobs = 0;
    while (chronicleJobs < this.options.memory.worker.maxJobsPerTick && !signal?.aborted) {
      const result = await processNextChronicle({
        repository: this.chronicle,
        client: this.options.client,
        model: this.options.model,
        workerId: this.options.workerId,
        contextWindowTokens: this.options.contextWindowTokens,
        now: this.now,
        signal,
      });
      if (result.status === "no_job") break;
      chronicleJobs += 1;
      await yieldToEventLoop();
    }
    const evidenceDeleted = await this.withEvidenceLock(() => cleanupEvidence(
      this.database,
      this.options.memoryRoot,
      this.options.memory.evidence,
      this.now(),
    ));
    return { chronicleJobs, evidenceDeleted };
  }

  async tickTurnMemory(signal?: AbortSignal) {
    await this.scanSessions({ includeInterrupted: false, signal });
    this.turnMemory.sealDueBatches(this.now());
    let turnMemoryJobs = 0;
    while (turnMemoryJobs < this.options.memory.worker.maxJobsPerTick && !signal?.aborted) {
      const result = await processNextTurnMemory({
        repository: this.turnMemory,
        client: this.options.client,
        model: this.options.model,
        workerId: this.options.workerId,
        contextWindowTokens: this.options.contextWindowTokens,
        now: this.now,
        signal,
      });
      if (result.status === "no_job") break;
      turnMemoryJobs += 1;
      await yieldToEventLoop();
    }
    return { turnMemoryJobs };
  }

  async tickConsolidation(signal?: AbortSignal) {
    return signal?.aborted
      ? { status: "skipped" as const, reason: "aborted" }
      : await processConsolidation({
          root: this.options.memoryRoot,
          repository: this.consolidation,
          client: this.options.client,
          model: this.options.model,
          workerId: this.options.workerId,
          contextWindowTokens: this.options.contextWindowTokens,
          now: this.now,
          signal,
        });
  }

  async tick(signal?: AbortSignal) {
    const [chronicle, turnMemory] = await Promise.all([
      this.tickChronicle(signal),
      this.tickTurnMemory(signal),
    ]);
    const consolidation = await this.tickConsolidation(signal);
    const { chronicleJobs, evidenceDeleted } = chronicle;
    const { turnMemoryJobs } = turnMemory;
    return { chronicleJobs, turnMemoryJobs, consolidation, evidenceDeleted };
  }

  close() {
    this.database.close();
  }
}
