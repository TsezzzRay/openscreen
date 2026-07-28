import type OpenAI from "openai";

import {
  appendTimelineEntry,
  readTimelineEntries,
  withActivityLock,
} from "./store.js";
import type {
  ActivitySource,
  TimelineEntry,
} from "./types.js";
import { containsSensitiveData } from "./types.js";

const TIMELINE_INSTRUCTIONS = `Convert one OpenScreen activity into one factual timeline entry.
Return only this JSON shape:
{"summary":"English factual summary","application":"optional application","windowTitle":"optional title","entities":["named entity"],"verbatimEvidence":["exact source text"]}
Always include summary, entities, and verbatimEvidence. Omit application and windowTitle when unknown.
Write generated summaries in English.
Preserve user text, code, errors, URLs, paths, and proper nouns verbatim.
Do not infer user preferences from screen content.
Do not describe failed or cancelled work as successful.`;

export function buildTimelineRequest(
  model: string,
  source: ActivitySource,
  maxOutputTokens: number,
): OpenAI.Responses.ResponseCreateParamsNonStreaming {
  if (source.type === "turn") {
    return {
      model,
      instructions: TIMELINE_INSTRUCTIONS,
      input: [{
        role: "user",
        content: JSON.stringify({
          type: source.type,
          sessionId: source.sessionId,
          occurredAt: source.occurredAt,
          turn: source.turn,
          ...(source.agentRun ? { agentRun: source.agentRun } : {}),
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
    instructions: TIMELINE_INSTRUCTIONS,
    input: [{ role: "user", content }],
    max_output_tokens: maxOutputTokens,
  };
}

export function timelineSourceKey(source: ActivitySource) {
  if (source.type === "turn" && source.agentRun?.id !== undefined &&
      source.agentRun.id !== source.turn.id) {
    throw new Error("Agent Run ID must match turn ID");
  }
  return source.type === "screen"
    ? `screen:${source.observation.id}`
    : `turn:${source.sessionId}:${source.turn.id}`;
}

type TimelineProcessResult =
  | { status: "created"; entry: TimelineEntry }
  | { status: "duplicate"; entry?: undefined }
  | { status: "discarded"; entry?: undefined };

function entrySourceKey(entry: TimelineEntry) {
  return entry.source.type === "screen"
    ? `screen:${entry.source.id}`
    : `turn:${entry.source.sessionId}:${entry.source.id}`;
}

function stringArray(value: unknown, name: string) {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`Invalid timeline ${name}`);
  }
  return value;
}

function parseTimelineOutput(output: string) {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    throw new Error("Model returned invalid timeline JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Model returned invalid timeline JSON");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.summary !== "string" || !record.summary.trim()) {
    throw new Error("Model returned an empty timeline summary");
  }
  for (const name of ["application", "windowTitle"] as const) {
    if (record[name] !== undefined && typeof record[name] !== "string") {
      throw new Error(`Invalid timeline ${name}`);
    }
  }
  if (containsSensitiveData(record)) {
    throw new Error("Timeline output contains sensitive data");
  }
  return {
    summary: record.summary.trim(),
    ...(record.application ? { application: record.application as string } : {}),
    ...(record.windowTitle ? { windowTitle: record.windowTitle as string } : {}),
    entities: stringArray(record.entities, "entities"),
    verbatimEvidence: stringArray(record.verbatimEvidence, "verbatimEvidence"),
  };
}

export async function processTimelineSource({
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
}): Promise<TimelineProcessResult> {
  return withActivityLock(root, async () => {
    const sourceKey = timelineSourceKey(source);
    if ((await readTimelineEntries(root)).some((entry) => entrySourceKey(entry) === sourceKey)) {
      return { status: "duplicate" };
    }

    const request = buildTimelineRequest(model, source, maxOutputTokens);
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
    const generated = parseTimelineOutput(response.output_text);
    const entry: TimelineEntry = {
      schemaVersion: 1,
      id: `timeline:${sourceKey}`,
      occurredAt: source.type === "screen"
        ? source.observation.occurredAt
        : source.occurredAt,
      createdAt: now().toISOString(),
      source: source.type === "screen"
        ? { type: "screen", id: source.observation.id }
        : { type: "turn", id: source.turn.id, sessionId: source.sessionId },
      status: source.type === "screen"
        ? "observed"
        : source.agentRun?.status ?? source.turn.status,
      ...generated,
    };
    await appendTimelineEntry(root, entry);
    return { status: "created", entry };
  });
}
