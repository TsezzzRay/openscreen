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

/** Plain-text rendering of a Chronicle window's summary for Mastra — no provenance header, that stays in the rollout file only. */
export function chronicleObservationText(summary: ChronicleSummary): string {
  return [
    summary.sourceSummary,
    ...summary.activities.map((activity, index) => {
      const parts = [`Activity ${index + 1}: ${activity.summary}`];
      if (activity.application !== undefined) parts.push(`(application: ${activity.application})`);
      if (activity.windowTitle !== undefined) parts.push(`(window: ${activity.windowTitle})`);
      return parts.join(" ");
    }),
  ].join("\n");
}
