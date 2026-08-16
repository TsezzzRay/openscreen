import type { ChronicleActivity, ChronicleSummary } from "./types.js";

export const CHRONICLE_SUMMARY_SCHEMA = {
  type: "object",
  properties: {
    activities: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        properties: {
          summary: { type: "string", minLength: 1, maxLength: 2_000 },
          source_frame_ids: {
            type: "array",
            minItems: 1,
            items: { type: "string", minLength: 1 },
          },
          application: { type: ["string", "null"], maxLength: 500 },
          window_title: { type: ["string", "null"], maxLength: 1_000 },
        },
        required: ["summary", "source_frame_ids", "application", "window_title"],
        additionalProperties: false,
      },
    },
    source_summary: { type: "string", minLength: 1, maxLength: 4_000 },
  },
  required: ["activities", "source_summary"],
  additionalProperties: false,
} as const;

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Invalid Chronicle ${name}`);
  }
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: readonly string[], name: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`Invalid Chronicle ${name}`);
  }
}

function text(value: unknown, name: string, maximum: number, optional = false): string | undefined {
  if (optional && (value === null || value === "")) return undefined;
  if (typeof value !== "string" || value.trim() === "") throw new Error(`Invalid Chronicle ${name}`);
  const result = value.trim();
  if (Array.from(result).length > maximum) throw new Error(`Invalid Chronicle ${name}`);
  return result;
}

function activity(value: unknown): ChronicleActivity {
  const input = record(value, "activity");
  exact(input, ["summary", "source_frame_ids", "application", "window_title"], "activity");
  if (!Array.isArray(input.source_frame_ids) || input.source_frame_ids.length === 0) {
    throw new Error("Invalid Chronicle activity source_frame_ids");
  }
  const sourceFrameIds = input.source_frame_ids.map((id) => text(id, "activity source_frame_id", 1_000)!);
  return {
    summary: text(input.summary, "activity summary", 2_000)!,
    sourceFrameIds,
    ...(text(input.application, "activity application", 500, true) === undefined
      ? {}
      : { application: text(input.application, "activity application", 500, true) }),
    ...(text(input.window_title, "activity window_title", 1_000, true) === undefined
      ? {}
      : { windowTitle: text(input.window_title, "activity window_title", 1_000, true) }),
  };
}

export function parseChronicleSummary(
  value: unknown,
  expectedSourceFrameIds: ReadonlySet<string>,
): ChronicleSummary {
  const root = record(value, "output");
  exact(root, ["activities", "source_summary"], "output");
  if (!Array.isArray(root.activities) || root.activities.length === 0) {
    throw new Error("Invalid Chronicle activities");
  }
  const activities = root.activities.map(activity);
  const covered = new Set<string>();
  for (const item of activities) {
    for (const sourceId of item.sourceFrameIds) {
      if (!expectedSourceFrameIds.has(sourceId)) {
        throw new Error(`Chronicle returned source ${sourceId}`);
      }
      if (covered.has(sourceId)) {
        throw new Error(`Chronicle returned source ${sourceId} more than once`);
      }
      covered.add(sourceId);
    }
  }
  for (const sourceId of expectedSourceFrameIds) {
    if (!covered.has(sourceId)) throw new Error(`Chronicle output is missing source ${sourceId}`);
  }
  return {
    activities,
    sourceSummary: text(root.source_summary, "source_summary", 4_000)!,
  };
}
