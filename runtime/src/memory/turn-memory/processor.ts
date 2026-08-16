import {
  hasApi,
  type Model,
  type Models,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";

import { projectPendingMemoryArtifacts } from "../artifact-projector.js";
import {
  buildTurnMemoryContext,
  estimateTurnMemoryInputTokens,
  parseTurnMemoryExtraction,
  TURN_MEMORY_TOOL_NAME,
  validateTurnMemoryExtraction,
} from "./extractor.js";
import type { TurnMemoryRepository } from "./repository.js";

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function processNextTurnMemory({
  repository,
  models,
  model,
  workerId,
  memoryRoot,
  now = Date.now,
  signal,
}: {
  repository: TurnMemoryRepository;
  models: Models;
  model: Model<string>;
  workerId: string;
  memoryRoot: string;
  now?: () => number;
  signal?: AbortSignal;
}): Promise<
  | { status: "no_job" }
  | { status: "processed"; jobKey: string; projectedArtifacts: number; projectionError?: string }
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
      controller.abort("Turn Memory ownership lost");
    }
  }, Math.max(1_000, Math.floor(repository.policy.worker.leaseMilliseconds / 3)));
  heartbeat.unref();
  try {
    const input = repository.loadClaimProjection(claim);
    const estimatedTokens = estimateTurnMemoryInputTokens(input);
    if (estimatedTokens > repository.policy.maxInputTokens) {
      throw new Error(
        `Turn Memory input exceeds its token budget (${estimatedTokens} > ${repository.policy.maxInputTokens})`,
      );
    }
    const context = buildTurnMemoryContext(input);
    const options = {
      maxTokens: repository.policy.maxOutputTokens,
      temperature: 0,
      cacheRetention: "none",
      signal: controller.signal,
    } satisfies SimpleStreamOptions;
    const response = hasApi(model, "anthropic-messages")
      ? await models.complete(model, context, {
          ...options,
          toolChoice: { type: "tool", name: TURN_MEMORY_TOOL_NAME },
        })
      : await models.completeSimple(model, context, options);
    if (response.stopReason === "error" || response.stopReason === "aborted") {
      throw new Error(
        response.errorMessage ??
          `Turn Memory model stopped with ${response.stopReason}`,
      );
    }
    if (response.stopReason !== "toolUse") {
      throw new Error(
        `Turn Memory model must return exactly one Turn Memory tool call; stopped with ${response.stopReason}`,
      );
    }
    const toolCalls = response.content.filter((block) => block.type === "toolCall");
    if (toolCalls.length !== 1) {
      throw new Error("Turn Memory model must return exactly one Turn Memory tool call");
    }
    const toolCall = toolCalls[0]!;
    if (toolCall.name !== TURN_MEMORY_TOOL_NAME) {
      throw new Error(`Unexpected Turn Memory tool ${toolCall.name}`);
    }
    const extraction = parseTurnMemoryExtraction(toolCall.arguments);
    validateTurnMemoryExtraction(input, extraction);
    repository.complete(claim, input, extraction, now());
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
      projectedArtifacts: 0,
      projectionError: message(error),
    };
  }
}
