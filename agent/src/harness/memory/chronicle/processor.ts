import type OpenAI from "openai";

import {
  countModelRequestTokens,
  executeModelRequest,
} from "../shared/model-request.js";
import { modelInputTokenBudget } from "../shared/request-budget.js";
import { buildChronicleSummaryRequest, parseChronicleSummary } from "./summarizer.js";
import type { ChronicleObservationProjection, ChronicleSummary } from "./types.js";
import type { ChronicleRepository } from "./repository.js";

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function combine(outputs: ChronicleSummary[]): ChronicleSummary {
  return {
    activities: outputs.flatMap(({ activities }) => activities),
    sourceSummary: outputs.map(({ sourceSummary }) => sourceSummary).join("\n\n"),
  };
}

export async function processNextChronicle({
  repository,
  client,
  model,
  workerId,
  contextWindowTokens,
  now = Date.now,
  signal,
}: {
  repository: ChronicleRepository;
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
      controller.abort("Chronicle ownership lost");
    }
  }, repository.config.worker.heartbeatMilliseconds);
  heartbeat.unref();
  try {
    const budget = modelInputTokenBudget({
      operation: "Chronicle",
      contextWindowTokens,
      maxInputTokens: repository.config.chronicle.maxInputTokens,
      maxOutputTokens: repository.config.chronicle.maxOutputTokens,
      contextWindowFraction: { numerator: 7, denominator: 10 },
    });
    const pending = repository.loadClaimSources(claim);
    const outputs: ChronicleSummary[] = [];
    let offset = 0;
    while (offset < pending.length) {
      const maximum = repository.config.chronicle.maxSourcesPerRequest;
      let candidates = pending.slice(offset, offset + maximum);
      let request = buildChronicleSummaryRequest(model, {
        type: "chronicle_window",
        observations: candidates,
      }, repository.config.chronicle.maxOutputTokens);
      let tokens = await countModelRequestTokens(client, request, controller.signal);
      if (tokens > budget) {
        let low = 1;
        let high = candidates.length - 1;
        let fit: {
          candidates: ChronicleObservationProjection[];
          request: typeof request;
          tokens: number;
        } | undefined;
        while (low <= high) {
          const count = Math.ceil((low + high) / 2);
          const selected = candidates.slice(0, count);
          const candidateRequest = buildChronicleSummaryRequest(model, {
            type: "chronicle_window",
            observations: selected,
          }, repository.config.chronicle.maxOutputTokens);
          const candidateTokens = await countModelRequestTokens(
            client,
            candidateRequest,
            controller.signal,
          );
          if (candidateTokens <= budget) {
            fit = { candidates: selected, request: candidateRequest, tokens: candidateTokens };
            low = count + 1;
          } else high = count - 1;
        }
        if (!fit) {
          throw new Error(`A single Chronicle source exceeds the input budget`);
        }
        candidates = fit.candidates;
        request = fit.request;
        tokens = fit.tokens;
      }
      const expected = new Set(candidates.map(({ sourceId }) => sourceId));
      outputs.push(await executeModelRequest({
        recorder: repository,
        operation: "chronicle_summarization",
        jobKey: claim.jobKey,
        client,
        request,
        inputTokens: tokens,
        parse: (output) => parseChronicleSummary(output, expected),
        now,
        signal: controller.signal,
      }));
      offset += candidates.length;
    }
    repository.complete(claim, combine(outputs), now());
    return { status: "processed", jobKey: claim.jobKey, requestCount: outputs.length };
  } catch (error) {
    const errorMessage = message(error);
    repository.fail(claim, errorMessage, now());
    return { status: "failed", jobKey: claim.jobKey, error: errorMessage };
  } finally {
    clearInterval(heartbeat);
    signal?.removeEventListener("abort", abort);
  }
}
