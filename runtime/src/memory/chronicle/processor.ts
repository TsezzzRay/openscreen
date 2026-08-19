import {
  hasApi,
  type Context,
  type Model,
  type Models,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";

import type { WritePathDeps } from "../mastra/write-path.js";
import { recordChronicleWindow } from "../mastra/write-path.js";
import { chronicleObservationText, renderChronicleRollout } from "./rollout.js";
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

// Keeps the forced-tool-call + recursive-split model logic from the original
// implementation unchanged. Drops claim/lease/heartbeat/complete — there is
// no job queue anymore, just a single background loop calling this directly
// for each due window (see cursors.ts's dueChronicleWindows /
// loadChronicleWindowFrames / markChronicleWindowSummarized).

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

export interface ChronicleWindowPolicy {
  maxSourcesPerRequest: number;
  maxInputTokens: number;
  maxOutputTokens: number;
}

// A rejected tool call (bad shape, duplicate/missing source, etc.) previously
// failed the whole batch immediately, burning one of the window's limited
// MAX_SUMMARIZE_ATTEMPTS retries on what is often a one-off structured-output
// slip. Real diagnostics.log data showed MiniMax tripping every validation
// layer (top-level shape, empty activities, per-activity shape, duplicate
// source coverage) within a single hour under load. Giving the model the
// rejection reason and a chance to resubmit — mirroring the existing
// stopReason:"length" repair path — fixes most of these in place instead of
// losing the batch. The schema itself stays exact; only the number of chances
// to satisfy it goes up.
const MAX_REPAIR_ATTEMPTS = 2;

export async function summarizeChronicleWindow({
  windowId,
  frames,
  policy,
  models,
  model,
  writePath,
  now = Date.now,
  signal,
}: {
  windowId: string;
  frames: readonly ChronicleFrameProjection[];
  policy: ChronicleWindowPolicy;
  models: Models;
  model: Model<string>;
  writePath: WritePathDeps;
  now?: () => number;
  signal?: AbortSignal;
}): Promise<
  | { status: "summarized"; requestCount: number }
  | { status: "failed"; error: string }
> {
  let requestCount = 0;
  try {
    const outputs: ChronicleSummary[] = [];
    const request = async (
      context: Context,
      batch: readonly ChronicleFrameProjection[],
      repairsLeft: number,
    ): Promise<ChronicleSummary[]> => {
      if (signal?.aborted) throw signal.reason ?? new Error("Chronicle aborted");
      const options = {
        maxTokens: policy.maxOutputTokens,
        temperature: 0,
        cacheRetention: "none",
        signal,
      } satisfies SimpleStreamOptions;
      const response = hasApi(model, "anthropic-messages")
        ? await models.complete(model, context, {
            ...options,
            toolChoice: { type: "tool", name: CHRONICLE_SUMMARY_TOOL_NAME },
          })
        : await models.completeSimple(model, context, options);
      requestCount += 1;
      if (signal?.aborted) throw signal.reason ?? new Error("Chronicle aborted");
      if (response.stopReason === "error" || response.stopReason === "aborted") {
        throw new Error(
          response.errorMessage ?? `Chronicle model stopped with ${response.stopReason}`,
        );
      }
      if (response.stopReason === "length") {
        if (batch.length === 1) {
          throw new Error("Chronicle model reached its output limit for one source");
        }
        const split = Math.ceil(batch.length / 2);
        return [
          ...await summarize(batch.slice(0, split)),
          ...await summarize(batch.slice(split)),
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
      try {
        return [parseChronicleSummary(
          toolCall.arguments,
          new Set(batch.map(({ sourceId }) => sourceId)),
        )];
      } catch (error) {
        if (repairsLeft <= 0) throw error;
        const repairContext: Context = {
          ...context,
          messages: [
            ...context.messages,
            response,
            {
              role: "toolResult",
              toolCallId: toolCall.id,
              toolName: toolCall.name,
              content: [{
                type: "text",
                text: `Rejected: ${message(error)}. Re-submit ${CHRONICLE_SUMMARY_TOOL_NAME} with corrected arguments covering the same sources.`,
              }],
              isError: true,
              timestamp: now(),
            },
          ],
        };
        return request(repairContext, batch, repairsLeft - 1);
      }
    };
    const summarize = (
      batch: readonly ChronicleFrameProjection[],
    ): Promise<ChronicleSummary[]> =>
      request(buildChronicleContext(batch), batch, MAX_REPAIR_ATTEMPTS);
    let offset = 0;
    while (offset < frames.length) {
      const batch = nextChunk(frames, offset, policy.maxSourcesPerRequest, policy.maxInputTokens);
      outputs.push(...await summarize(batch));
      offset += batch.length;
    }
    const summary = combine(outputs);
    const rollout = renderChronicleRollout({
      jobKey: windowId,
      sources: frames,
      summary,
      generatedAt: now(),
    });
    await recordChronicleWindow(writePath, chronicleObservationText(summary), {
      relativePath: rollout.relativePath,
      content: rollout.content,
    });
    return { status: "summarized", requestCount };
  } catch (error) {
    return { status: "failed", error: message(error) };
  }
}
