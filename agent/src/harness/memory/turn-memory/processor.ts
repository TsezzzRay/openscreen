import type OpenAI from "openai";

import {
  countModelRequestTokens,
  executeModelRequest,
} from "../shared/model-request.js";
import { turnMemoryInputTokenBudget } from "../shared/request-budget.js";
import { buildTurnMemoryExtractionRequest, parseTurnMemoryExtraction } from "./extractor.js";
import type { TurnMemoryRepository } from "./repository.js";

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export async function processNextTurnMemory({
  repository,
  client,
  model,
  workerId,
  contextWindowTokens,
  now = Date.now,
  signal,
}: {
  repository: TurnMemoryRepository;
  client: OpenAI;
  model: string;
  workerId: string;
  contextWindowTokens: number;
  now?: () => number;
  signal?: AbortSignal;
}): Promise<
  | { status: "no_job" }
  | { status: "processed"; jobKey: string; requestCount: number }
  | { status: "failed"; jobKey: string; error: string }
> {
  const claim = repository.claimNext({ workerId, now: now() });
  if (!claim) return { status: "no_job" };
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const heartbeat = setInterval(() => {
    if (!repository.heartbeat(claim, now())) {
      controller.abort("Turn Memory ownership lost");
    }
  }, repository.config.worker.heartbeatMilliseconds);
  heartbeat.unref();
  try {
    const budget = turnMemoryInputTokenBudget({
      contextWindowTokens,
      maxInputTokens: repository.config.turnMemory.maxInputTokens,
      maxOutputTokens: repository.config.turnMemory.maxOutputTokens,
    });
    const input = repository.loadClaimSources(claim);
    const request = buildTurnMemoryExtractionRequest(
      model,
      input,
      repository.config.turnMemory.maxOutputTokens,
    );
    const tokens = await countModelRequestTokens(client, request, controller.signal);
    if (tokens > budget) {
      throw new Error(
        `Turn Memory input exceeds the model context budget (${tokens} > ${budget})`,
      );
    }
    const output = await executeModelRequest({
      recorder: repository,
      operation: "turn_memory_extraction",
      jobKey: claim.jobKey,
      client,
      request,
      inputTokens: tokens,
      parse: parseTurnMemoryExtraction,
      now,
      signal: controller.signal,
    });
    repository.complete(claim, output, now());
    return { status: "processed", jobKey: claim.jobKey, requestCount: 1 };
  } catch (error) {
    const errorMessage = message(error);
    repository.fail(claim, errorMessage, now());
    return { status: "failed", jobKey: claim.jobKey, error: errorMessage };
  } finally {
    clearInterval(heartbeat);
    signal?.removeEventListener("abort", abort);
  }
}
