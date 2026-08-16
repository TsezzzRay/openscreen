import {
  hasApi,
  type Model,
  type Models,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";

import { projectPendingMemoryArtifacts } from "../artifact-projector.js";
import type { ChronicleRepository } from "./repository.js";
import {
  buildChronicleContext,
  CHRONICLE_SUMMARY_TOOL_NAME,
  estimateChronicleInputTokens,
} from "./summarizer.js";
import { parseChronicleSummary } from "./summary-schema.js";
import type {
  ChronicleFrameProjection,
  ChronicleSummary,
} from "./types.js";

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function combine(outputs: readonly ChronicleSummary[]): ChronicleSummary {
  return {
    activities: outputs.flatMap(({ activities }) => activities),
    sourceSummary: outputs.map(({ sourceSummary }) => sourceSummary).join("\n\n"),
  };
}

function nextChunk(
  pending: readonly ChronicleFrameProjection[],
  offset: number,
  maximumSources: number,
  tokenBudget: number,
): ChronicleFrameProjection[] {
  const upperBound = Math.min(pending.length, offset + maximumSources);
  for (let end = upperBound; end > offset; end -= 1) {
    const candidate = pending.slice(offset, end);
    if (estimateChronicleInputTokens(candidate) <= tokenBudget) return candidate;
  }
  throw new Error("A single Chronicle source exceeds the input budget");
}

export async function processNextChronicle({
  repository,
  models,
  model,
  workerId,
  memoryRoot,
  now = Date.now,
  signal,
}: {
  repository: ChronicleRepository;
  models: Models;
  model: Model<string>;
  workerId: string;
  memoryRoot: string;
  now?: () => number;
  signal?: AbortSignal;
}): Promise<
  | { status: "no_job" }
  | {
      status: "processed";
      jobKey: string;
      requestCount: number;
      projectedArtifacts: number;
      projectionError?: string;
    }
  | { status: "failed"; jobKey: string; error: string }
> {
  const claim = repository.claimNext({ workerId, now: now() });
  if (claim === null) return { status: "no_job" };
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const heartbeat = setInterval(() => {
    if (!repository.heartbeat(claim, now())) {
      controller.abort("Chronicle ownership lost");
    }
  }, Math.max(1_000, Math.floor(repository.policy.worker.leaseMilliseconds / 3)));
  heartbeat.unref();
  let requestCount = 0;
  try {
    const pending = repository.loadClaimSources(claim);
    const outputs: ChronicleSummary[] = [];
    const summarize = async (
      frames: readonly ChronicleFrameProjection[],
    ): Promise<ChronicleSummary[]> => {
      if (controller.signal.aborted) {
        throw controller.signal.reason ?? new Error("Chronicle aborted");
      }
      if (!repository.heartbeat(claim, now())) {
        throw new Error("Chronicle ownership lost");
      }
      const context = buildChronicleContext(frames);
      const options = {
        maxTokens: repository.policy.maxOutputTokens,
        temperature: 0,
        cacheRetention: "none",
        signal: controller.signal,
      } satisfies SimpleStreamOptions;
      const response = hasApi(model, "anthropic-messages")
        ? await models.complete(model, context, {
            ...options,
            toolChoice: {
              type: "tool",
              name: CHRONICLE_SUMMARY_TOOL_NAME,
            },
          })
        : await models.completeSimple(model, context, options);
      requestCount += 1;
      if (controller.signal.aborted) {
        throw controller.signal.reason ?? new Error("Chronicle aborted");
      }
      if (response.stopReason === "error" || response.stopReason === "aborted") {
        throw new Error(
          response.errorMessage ?? `Chronicle model stopped with ${response.stopReason}`,
        );
      }
      if (response.stopReason === "length") {
        if (frames.length === 1) {
          throw new Error("Chronicle model reached its output limit for one source");
        }
        const split = Math.ceil(frames.length / 2);
        return [
          ...await summarize(frames.slice(0, split)),
          ...await summarize(frames.slice(split)),
        ];
      }
      if (response.stopReason !== "toolUse") {
        throw new Error(
          `Chronicle model must return exactly one Chronicle tool call; stopped with ${response.stopReason}`,
        );
      }
      const toolCalls = response.content.filter((block) => block.type === "toolCall");
      if (toolCalls.length !== 1) {
        throw new Error("Chronicle model must return exactly one Chronicle tool call");
      }
      const toolCall = toolCalls[0]!;
      if (toolCall.name !== CHRONICLE_SUMMARY_TOOL_NAME) {
        throw new Error(`Unexpected Chronicle tool ${toolCall.name}`);
      }
      return [parseChronicleSummary(
        toolCall.arguments,
        new Set(frames.map(({ sourceId }) => sourceId)),
      )];
    };
    let offset = 0;
    while (offset < pending.length) {
      const frames = nextChunk(
        pending,
        offset,
        repository.policy.maxSourcesPerRequest,
        repository.policy.maxInputTokens,
      );
      outputs.push(...await summarize(frames));
      offset += frames.length;
    }
    if (controller.signal.aborted) {
      throw controller.signal.reason ?? new Error("Chronicle aborted");
    }
    repository.complete(claim, combine(outputs), now());
  } catch (error) {
    const errorMessage = message(error);
    repository.fail(claim, errorMessage, now());
    return { status: "failed", jobKey: claim.jobKey, error: errorMessage };
  } finally {
    clearInterval(heartbeat);
    signal?.removeEventListener("abort", abort);
  }
  try {
    return {
      status: "processed",
      jobKey: claim.jobKey,
      requestCount,
      projectedArtifacts: await projectPendingMemoryArtifacts(
        memoryRoot,
        repository,
        now(),
      ),
    };
  } catch (error) {
    return {
      status: "processed",
      jobKey: claim.jobKey,
      requestCount,
      projectedArtifacts: 0,
      projectionError: message(error),
    };
  }
}
