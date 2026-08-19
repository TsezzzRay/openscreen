import type { ChronicleActivity, ChronicleSummary } from "./types.js";

// The `maxLength` values in the schema below are guidance to the model, not
// locally enforced limits — see the note on text() for why. They are kept
// because telling the model to aim short measurably shapes its output; they are
// deliberately not re-checked after the fact.
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

/**
 * Free-form model prose. Shape is validated; length deliberately is not.
 *
 * Total output is already bounded at the provider by `maxTokens:
 * policy.maxOutputTokens` in chronicle/processor.ts, and overflow there has a
 * *repairing* path — `stopReason: "length"` recursively splits the batch so
 * each request needs a shorter summary. A second character-based cap here
 * added nothing but failures: it fires earlier than the token limit, has no
 * repair path, and mixes units (a 2,000-character English summary is ~500
 * tokens, a Chinese one ~2,000 — and this pipeline deliberately preserves
 * original-language content, so both occur).
 *
 * Rejecting on length was also disproportionate: it cost the *entire* window,
 * retried and then permanently abandoned at MAX_SUMMARIZE_ATTEMPTS, losing
 * that minute of screen history from both ACTIVITY.md and the rollout
 * archive. Truncating instead was no better — observed on real capture data,
 * it fired on 9 of ~16 summaries, and because activity summaries are
 * chronological, cutting the tail systematically drops the newest events
 * rather than degrading evenly.
 *
 * So: length is not enforced here. Semantic problems that mean the output is
 * untrustworthy — invented source IDs, incomplete coverage, malformed shape —
 * still reject loudly below.
 */
function text(value: unknown, name: string, optional = false): string | undefined {
  if (optional && (value === null || value === "")) return undefined;
  if (typeof value !== "string" || value.trim() === "") throw new Error(`Invalid Chronicle ${name}`);
  return value.trim();
}

/**
 * Identifiers, which must match a real frame exactly. Never truncated — a
 * shortened ID could collide with a different real frame. A length far beyond
 * any real source ID indicates a malformed response rather than merely verbose
 * output, so it is rejected.
 */
function identifier(value: unknown, name: string, maximum: number): string {
  const result = text(value, name)!;
  if (Array.from(result).length > maximum) throw new Error(`Invalid Chronicle ${name}`);
  return result;
}

function activity(value: unknown): ChronicleActivity {
  const input = record(value, "activity");
  exact(input, ["summary", "source_frame_ids", "application", "window_title"], "activity");
  if (!Array.isArray(input.source_frame_ids) || input.source_frame_ids.length === 0) {
    throw new Error("Invalid Chronicle activity source_frame_ids");
  }
  // Identifiers stay bounded and exact — see text() vs identifier() above.
  const sourceFrameIds = input.source_frame_ids.map((id) => identifier(id, "activity source_frame_id", 1_000));
  const application = text(input.application, "activity application", true);
  const windowTitle = text(input.window_title, "activity window_title", true);
  return {
    summary: text(input.summary, "activity summary")!,
    sourceFrameIds,
    ...(application === undefined ? {} : { application }),
    ...(windowTitle === undefined ? {} : { windowTitle }),
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
    sourceSummary: text(root.source_summary, "source_summary")!,
  };
}
