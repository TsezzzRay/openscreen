import type OpenAI from "openai";

import {
  appendActivityRecord,
  readActivityRecords,
} from "./store.js";
import { withMemoryLock } from "../lock.js";
import type {
  ActivitySource,
  ActivityRecord,
} from "./types.js";

const ACTIVITY_INSTRUCTIONS = `Convert one OpenScreen activity into one factual activity record.
Return only this JSON shape:
{"summary":"English factual summary","application":"optional application","windowTitle":"optional title","entities":["named entity"],"verbatimEvidence":["exact source text"]}
Always include summary, entities, and verbatimEvidence. Omit application and windowTitle when unknown.
Write generated summaries in English.
Preserve user text, code, errors, URLs, paths, and proper nouns verbatim.
Do not infer user preferences from screen content.
Do not describe failed or cancelled work as successful.`;

export function buildActivityRequest(
  model: string,
  source: ActivitySource,
  maxOutputTokens: number,
): OpenAI.Responses.ResponseCreateParamsNonStreaming {
  if (source.type === "turn") {
    return {
      model,
      instructions: ACTIVITY_INSTRUCTIONS,
      input: [{
        role: "user",
        content: JSON.stringify({
          type: source.type,
          sessionId: source.sessionId,
          occurredAt: source.occurredAt,
          turn: source.turn,
          agentRuns: source.agentRuns,
        }),
      }],
      max_output_tokens: maxOutputTokens,
    };
  }

  const { dataBase64, ...screenshot } = source.observation.screenshot;
  const observation = { ...source.observation, screenshot };
  const content: OpenAI.Responses.ResponseInputContent[] = [{
    type: "input_text",
    text: JSON.stringify({ type: source.type, observation }),
  }];
  if (dataBase64) {
    const imageURL =
      `data:${source.observation.screenshot.mimeType ?? "image/jpeg"};base64,${dataBase64}`;
    content.push((model.toLowerCase() === "minimax-m3"
      ? {
          type: "input_image",
          image_url: { url: imageURL, detail: "default" },
        }
      : {
          type: "input_image",
          detail: "auto",
          image_url: imageURL,
        }) as unknown as OpenAI.Responses.ResponseInputImage);
  }

  return {
    model,
    instructions: ACTIVITY_INSTRUCTIONS,
    input: [{ role: "user", content }],
    max_output_tokens: maxOutputTokens,
  };
}

export function activitySourceKey(source: ActivitySource) {
  if (source.type === "turn" &&
      source.agentRuns.some(({ turnId }) => turnId !== source.turn.id)) {
    throw new Error("Agent Run must reference the source Turn");
  }
  return source.type === "screen_observation"
    ? `screen_observation:${source.observation.id}`
    : `turn:${source.sessionId}:${source.turn.id}`;
}

type ActivityProcessResult =
  | { status: "created"; record: ActivityRecord }
  | { status: "duplicate"; record?: undefined }
  | { status: "discarded"; record?: undefined };

function recordSourceKeys(record: ActivityRecord) {
  return record.sources.map((source) => source.type === "screen_observation"
    ? `screen_observation:${source.observationId}`
    : `turn:${source.sessionId}:${source.turnId}`);
}

function stringArray(value: unknown, name: string) {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`Invalid activity ${name}`);
  }
  return value;
}

function parseActivityOutput(output: string) {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    throw new Error("Model returned invalid activity JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Model returned invalid activity JSON");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.summary !== "string" || !record.summary.trim()) {
    throw new Error("Model returned an empty activity summary");
  }
  for (const name of ["application", "windowTitle"] as const) {
    if (record[name] !== undefined && typeof record[name] !== "string") {
      throw new Error(`Invalid activity ${name}`);
    }
  }
  return {
    summary: record.summary.trim(),
    ...(record.application ? { application: record.application as string } : {}),
    ...(record.windowTitle ? { windowTitle: record.windowTitle as string } : {}),
    entities: stringArray(record.entities, "entities"),
    verbatimEvidence: stringArray(record.verbatimEvidence, "verbatimEvidence"),
  };
}

export async function processActivitySource({
  root,
  client,
  model,
  source,
  maxInputTokens,
  maxOutputTokens,
  now = () => new Date(),
  signal,
}: {
  root: string;
  client: OpenAI;
  model: string;
  source: ActivitySource;
  maxInputTokens: number;
  maxOutputTokens: number;
  now?: () => Date;
  signal?: AbortSignal;
}): Promise<ActivityProcessResult> {
  return withMemoryLock(root, async () => {
    const sourceKey = activitySourceKey(source);
    if ((await readActivityRecords(root)).some(
      (record) => recordSourceKeys(record).includes(sourceKey),
    )) {
      return { status: "duplicate" };
    }

    const request = buildActivityRequest(model, source, maxOutputTokens);
    const inputTokens = (
      await client.responses.inputTokens.count({
        model: request.model,
        instructions: request.instructions,
        input: request.input,
      }, { signal })
    ).input_tokens;
    if (inputTokens >= maxInputTokens) {
      return { status: "discarded" };
    }
    const response = await client.responses.create(request, { signal });
    const generated = parseActivityOutput(response.output_text);
    const record: ActivityRecord = {
      schemaVersion: 1,
      id: `activity:${sourceKey}`,
      occurredAt: source.type === "screen_observation"
        ? source.observation.occurredAt
        : source.occurredAt,
      createdAt: now().toISOString(),
      sources: source.type === "screen_observation"
        ? [{
            type: "screen_observation",
            observationId: source.observation.id,
          }]
        : [{
            type: "turn",
            turnId: source.turn.id,
            sessionId: source.sessionId,
            agentRunIds: source.agentRuns.map(({ id }) => id),
          }],
      status: source.type === "screen_observation"
        ? "observed"
        : source.turn.status,
      ...generated,
    };
    await appendActivityRecord(root, record);
    return { status: "created", record };
  });
}
