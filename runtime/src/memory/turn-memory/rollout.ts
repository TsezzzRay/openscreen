import { createHash } from "node:crypto";

import type { TurnMemorySource, TurnMemoryToolResult } from "./types.js";

export interface RenderedTurnRollout {
  relativePath: string;
  content: string;
  observationText: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function inline(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function toolLine(tool: TurnMemoryToolResult): string {
  return `- ${tool.name} [${tool.status}]: ${tool.result.replace(/\r?\n/g, " ")}`;
}

/**
 * Renders one completed Turn directly from its code-owned projection — no
 * extraction step. This is intentionally a plainer file than today's
 * extraction-derived rollout (no Outcome/Preference/Keywords fields): the
 * judgment about what's valuable now belongs to Mastra's Observer, reading
 * `observationText` below. `source_frame_ids` is deliberately omitted here
 * (see the migration plan): it was write-only in the old rollout, nothing
 * ever read it back, and the frames it points to expire long before turn
 * rollouts do. Chronicle's rollout keeps it, where it is load-bearing.
 */
export function renderTurnRollout(
  source: TurnMemorySource,
  generatedAt: number,
): RenderedTurnRollout {
  const time = source.startedAt.replace(/[:.]/g, "-");
  const stableSuffix = sha256(source.sourceId).slice(0, 12);
  const relativePath = `rollout_summaries/turn-${time}-${stableSuffix}.md`;
  // source.sourceId is already namespaced ("turn:<sessionId>:<entryId>"), no
  // extra prefix needed.
  const rolloutId = source.sourceId;
  const header = [
    `thread_id: ${inline(source.threadId)}`,
    `session_id: ${inline(source.sessionId)}`,
    `updated_at: ${new Date(generatedAt).toISOString()}`,
    `cwd: ${inline(source.cwd)}`,
    `git_branch: ${inline(source.gitBranch)}`,
    `rollout_path: ${inline(source.rolloutPath)}`,
    `rollout_id: ${rolloutId}`,
    `status: ${source.status}`,
  ].join("\n");
  const body = [
    "",
    "# User",
    source.user || "(none)",
    "",
    "# Assistant",
    source.assistant || "(none)",
    ...(source.compactionSummary === undefined
      ? []
      : ["", "# Prior compaction summary", source.compactionSummary]),
    ...(source.terminalError === undefined
      ? []
      : ["", "# Terminal error", source.terminalError]),
    ...(source.tools.length === 0 ? [] : ["", "# Tools", ...source.tools.map(toolLine)]),
    "",
  ].join("\n");
  const observationText = [
    `User: ${source.user || "(none)"}`,
    `Assistant: ${source.assistant || "(none)"}`,
    ...(source.tools.length === 0
      ? []
      : [`Tools used: ${source.tools.map((tool) => `${tool.name} (${tool.status})`).join(", ")}`]),
    ...(source.status !== "completed" ? [`Turn status: ${source.status}`] : []),
    ...(source.terminalError === undefined ? [] : [`Terminal error: ${source.terminalError}`]),
  ].join("\n");
  return {
    relativePath,
    content: `${header}\n${body}`,
    observationText,
  };
}
