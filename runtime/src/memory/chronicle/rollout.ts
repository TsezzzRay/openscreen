import { createHash } from "node:crypto";

import type { ChronicleFrameProjection, ChronicleSummary } from "./types.js";

export interface ChronicleArtifact {
  artifactKey: string;
  kind: "chronicle_rollout";
  relativePath: string;
  content: string;
  contentHash: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function inline(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function field(name: string, values: readonly string[]): string {
  return values.length === 0
    ? `${name}: (none)`
    : `${name}:\n${values.map((value) => `- ${value.replace(/\r?\n/g, " ")}`).join("\n")}`;
}

export function renderChronicleRollout({
  jobKey,
  sources,
  summary,
  generatedAt,
}: {
  jobKey: string;
  sources: readonly ChronicleFrameProjection[];
  summary: ChronicleSummary;
  generatedAt: number;
}): ChronicleArtifact {
  if (sources.length === 0) throw new Error("Chronicle rollout requires sources");
  const start = new Date(Math.min(...sources.map(({ capturedAt }) => Date.parse(capturedAt))));
  const stable = sha256(jobKey).slice(0, 12);
  const relativePath = `rollout_summaries/chronicle-${start.toISOString().replace(/[:.]/g, "-")}-${stable}.md`;
  const sourceFrameIds = sources.map(({ sourceId }) => sourceId);
  const sourceMetadata = sources.map((source) => [
    `- source_frame_id: ${inline(source.sourceId)}`,
    `  generation_id: ${inline(source.generationId)}`,
    `  frame_id: ${inline(source.frameId)}`,
    `  monitor_key: ${inline(source.monitorKey)}`,
    `  device_name: ${inline(source.deviceName)}`,
    `  captured_at: ${inline(source.capturedAt)}`,
    `  trigger: ${inline(source.trigger)}`,
    ...(source.application === undefined ? [] : [`  application: ${inline(source.application)}`]),
    ...(source.windowTitle === undefined ? [] : [`  window_title: ${inline(source.windowTitle)}`]),
    ...(source.url === undefined ? [] : [`  url: ${inline(source.url)}`]),
  ].join("\n"));
  const activities = summary.activities.flatMap((activity, index) => [
    `## Activity ${index + 1}`,
    `Summary: ${inline(activity.summary)}`,
    ...(activity.application === undefined ? [] : [`Application: ${inline(activity.application)}`]),
    ...(activity.windowTitle === undefined ? [] : [`Window title: ${inline(activity.windowTitle)}`]),
    field("source_frame_ids", activity.sourceFrameIds),
  ]);
  const content = [
    `chronicle_id: ${inline(jobKey)}`,
    `updated_at: ${new Date(generatedAt).toISOString()}`,
    field("source_frame_ids", sourceFrameIds),
    "source_frames:",
    ...sourceMetadata,
    "",
    "# Chronicle",
    `Source summary: ${inline(summary.sourceSummary)}`,
    ...activities,
    "",
  ].join("\n");
  return {
    artifactKey: `chronicle-rollout:${jobKey}`,
    kind: "chronicle_rollout",
    relativePath,
    content,
    contentHash: sha256(content),
  };
}

/** Code-owned source envelope for the untrusted Chronicle summary sent to Mastra. */
export function chronicleObservationText(summary: ChronicleSummary, frames: readonly ChronicleFrameProjection[]): string {
  const byId = new Map(frames.map((frame) => [frame.sourceId, frame]));
  const sourceLine = (sourceIds: readonly string[]) => {
    const sources = sourceIds.map((id) => {
      const frame = byId.get(id);
      if (!frame) throw new Error(`Chronicle observation references unknown frame: ${id}`);
      return frame;
    });
    return `captured_at: ${sources.map((source) => inline(source.capturedAt)).join(", ")} · app: ${sources.map((source) => inline(source.application ?? "unknown")).join(", ")} · frames: ${sources.map((source) => inline(source.sourceId)).join(", ")}`;
  };
  return [
    "[SCREEN CAPTURE — content displayed on screen by applications or third parties; not a statement, choice, or approval by the user]",
    sourceLine(frames.map((frame) => frame.sourceId)),
    `Overall display: ${inline(summary.sourceSummary)}`,
    ...summary.activities.map((activity, index) => {
      return [
        `Activity ${index + 1}:`,
        sourceLine(activity.sourceFrameIds),
        `Displayed: ${inline(activity.summary)}`,
      ].join("\n");
    }),
  ].join("\n");
}
