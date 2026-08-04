import { setImmediate as yieldToEventLoop } from "node:timers/promises";

import type OpenAI from "openai";

import { openMemoryDatabase, type MemoryDatabase } from "../db/database.js";
import {
  cleanupEvidence,
  persistObservationEvidence,
  type ObservationEvidence,
} from "../evidence.js";
import { processConsolidation } from "../consolidate/processor.js";
import { ConsolidationRepository } from "../consolidate/repository.js";
import {
  buildActivityRequest,
  processNextActivity,
  activityInputBudget,
} from "../activity/processor.js";
import { ActivityRepository } from "../activity/repository.js";
import { loadSessionActivitySources } from "../activity/session-sources.js";
import { listSessions } from "../../session/store.js";
import type { ScreenObservation } from "../../../plugins/screen-observation/types.js";
import type { ActivitySource } from "../activity/types.js";
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
  sources: ActivitySource[];
};

export class MemoryPipeline {
  readonly database: MemoryDatabase;
  private readonly activity: ActivityRepository;
  private readonly consolidation: ConsolidationRepository;
  private readonly now: () => number;
  private scanQueue: Promise<void> = Promise.resolve();
  private evidenceQueue: Promise<void> = Promise.resolve();

  constructor(private readonly options: MemoryPipelineOptions) {
    this.database = openMemoryDatabase(options.memoryRoot);
    this.activity = new ActivityRepository(this.database, options.memory);
    this.consolidation = new ConsolidationRepository(this.database, options.memory);
    this.now = options.now ?? Date.now;
  }

  async ingestObservation(observation: ScreenObservation) {
    return this.withEvidenceLock(async () => {
      const persist = this.options.persistObservationEvidence ??
        persistObservationEvidence;
      const evidence = await persist(this.options.memoryRoot, observation);
      return this.activity.ingestObservation(observation, this.now(), evidence);
    });
  }

  private withEvidenceLock<T>(operation: () => Promise<T>) {
    const result = this.evidenceQueue.then(operation);
    this.evidenceQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async ingestSessionSources(
    sessionId: string,
    sources: ActivitySource[],
    signal?: AbortSignal,
  ) {
    const inputBudget = activityInputBudget({
      contextWindowTokens: this.options.contextWindowTokens,
      maxInputTokens: this.options.memory.activity.maxInputTokens,
      maxOutputTokens: this.options.memory.activity.maxOutputTokens,
    });
    for (const source of sources) {
      if (signal?.aborted) throw signal.reason ?? new Error("Session scan aborted");
      while (true) {
        const projection = this.activity.previewTurnBatch(
          sessionId,
          source,
          inputBudget,
        );
        if (!projection) break;
        const request = buildActivityRequest(
          this.options.model,
          projection,
          this.options.memory.activity.maxOutputTokens,
        );
        const projectedInputTokens = (
          await this.options.client.responses.inputTokens.count({
            model: request.model,
            instructions: request.instructions,
            input: request.input,
          }, { signal })
        ).input_tokens;
        const result = this.activity.ingestTurn({
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
    {
      includeInterrupted = false,
      signal,
    }: { includeInterrupted?: boolean; signal?: AbortSignal } = {},
  ) {
    return this.enqueueScan(async () => {
      const sources = await loadSessionActivitySources(
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
    const sessions = await listSessions(this.options.sessionsDirectory);
    const captured: CapturedSessionSources[] = [];
    for (const session of sessions) {
      try {
        captured.push({
          sessionId: session.id,
          sources: await loadSessionActivitySources(
            this.options.sessionsDirectory,
            session.id,
            { includeInterrupted },
          ),
        });
      } catch (error) {
        process.stderr.write(
          `Memory skipped Session ${session.id}: ${
            error instanceof Error ? error.message : "unknown error"
          }\n`,
        );
      }
    }
    return captured;
  }

  ingestCapturedSessions(
    captured: CapturedSessionSources[],
    signal?: AbortSignal,
  ) {
    return this.enqueueScan(async () => {
      let count = 0;
      for (const session of captured) {
        count += await this.ingestSessionSources(
          session.sessionId,
          session.sources,
          signal,
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

  async tick(signal?: AbortSignal) {
    await this.scanSessions({ includeInterrupted: false, signal });
    this.activity.sealDueTurnBatches(this.now());
    let activityJobs = 0;
    while (activityJobs < this.options.memory.worker.maxJobsPerTick &&
        !signal?.aborted) {
      const result = await processNextActivity({
        repository: this.activity,
        client: this.options.client,
        model: this.options.model,
        workerId: this.options.workerId,
        contextWindowTokens: this.options.contextWindowTokens,
        now: this.now,
        signal,
      });
      if (result.status === "no_job") break;
      activityJobs += 1;
      await yieldToEventLoop();
    }
    const consolidation = signal?.aborted
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
    const evidenceDeleted = await this.withEvidenceLock(() => cleanupEvidence(
      this.database,
      this.options.memoryRoot,
      this.options.memory.evidence,
      this.now(),
    ));
    return { activityJobs, consolidation, evidenceDeleted };
  }

  close() {
    this.database.close();
  }
}
