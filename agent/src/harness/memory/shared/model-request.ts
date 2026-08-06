import { createHash, randomUUID } from "node:crypto";

import type OpenAI from "openai";

import { countResponseRequestTokens } from "../../../model-token-count.js";
import type {
  FinishModelAttempt,
  ModelOperation,
  StartModelAttempt,
} from "../db/attempts.js";

export type ModelAttemptRecorder = {
  startModelAttempt(attempt: StartModelAttempt): void;
  finishModelAttempt(attempt: FinishModelAttempt): void;
};

function characterCount(value: string) {
  return Array.from(value).length;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function errorProperty(error: unknown, key: "code" | "param") {
  if (!error || typeof error !== "object" || !(key in error)) return undefined;
  const value = (error as Record<string, unknown>)[key];
  return typeof value === "string" && value ? value : undefined;
}

export function modelRequestCharacters(
  request: OpenAI.Responses.ResponseCreateParamsNonStreaming,
) {
  return characterCount(JSON.stringify(request));
}

export async function countModelRequestTokens(
  client: OpenAI,
  request: OpenAI.Responses.ResponseCreateParamsNonStreaming,
  signal?: AbortSignal,
) {
  return countResponseRequestTokens(client, request, signal);
}

export async function executeModelRequest<T>({
  recorder,
  operation,
  jobKey,
  client,
  request,
  inputTokens,
  parse,
  now,
  signal,
}: {
  recorder: ModelAttemptRecorder;
  operation: ModelOperation;
  jobKey: string;
  client: OpenAI;
  request: OpenAI.Responses.ResponseCreateParamsNonStreaming;
  inputTokens: number;
  parse: (output: string) => T;
  now: () => number;
  signal?: AbortSignal;
}) {
  const id = `model-attempt:${randomUUID()}`;
  recorder.startModelAttempt({
    id,
    operation,
    jobKey,
    model: String(request.model),
    requestHash: createHash("sha256").update(JSON.stringify(request)).digest("hex"),
    requestCharacters: modelRequestCharacters(request),
    attemptedAt: now(),
    inputTokens,
  });
  let response: OpenAI.Responses.Response | undefined;
  try {
    response = await client.responses.create(request, { signal });
    const output = parse(response.output_text);
    recorder.finishModelAttempt({
      id,
      status: "succeeded",
      finishedAt: now(),
      outputTokens: response.usage?.output_tokens,
      outputCharacters: characterCount(response.output_text),
      responseStatus: response.status,
      incompleteReason: response.incomplete_details?.reason,
    });
    return output;
  } catch (error) {
    recorder.finishModelAttempt({
      id,
      status: signal?.aborted ? "cancelled" : "failed",
      finishedAt: now(),
      outputTokens: response?.usage?.output_tokens,
      outputCharacters: response ? characterCount(response.output_text) : undefined,
      responseStatus: response?.status,
      incompleteReason: response?.incomplete_details?.reason,
      errorCode: errorProperty(error, "code"),
      errorPath: errorProperty(error, "param"),
      errorMessage: errorMessage(error),
    });
    throw error;
  }
}
