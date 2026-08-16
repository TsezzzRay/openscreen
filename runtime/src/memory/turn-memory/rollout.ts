import { createHash } from "node:crypto";

import type {
  TurnMemoryBatchProjection,
  TurnMemoryExtraction,
  TurnMemoryTask,
} from "./types.js";

export interface RenderedMemoryArtifact {
  artifactKey: string;
  kind: "turn_rollout" | "raw_memories";
  relativePath: string;
  content: string;
  contentHash: string;
}

export interface RawMemoryArtifactInput {
  jobKey: string;
  rolloutSummaryFile: string;
  rawMemory: string;
  turnSummary: string;
  tasks: TurnMemoryTask[];
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function inline(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function bullet(value: string): string {
  return value.replace(/\r\n/g, "\n").trim().replace(/\n/g, "\n  ");
}

function field(name: string, values: readonly string[]): string {
  return values.length === 0
    ? `${name}: (none)`
    : `${name}:\n${values.map((value) => `- ${bullet(value)}`).join("\n")}`;
}

function taskMarkdown(task: TurnMemoryTask, index: number): string {
  return [
    `## Task ${index + 1}: ${inline(task.title)}`,
    `Outcome: ${task.outcome}`,
    field("Preference signals", task.preferenceSignals),
    field("Reusable knowledge", task.reusableKnowledge),
    field("Failures and how to do differently", task.failureLessons),
    field("References", task.references),
    field("Keywords", task.keywords),
  ].join("\n");
}

export function renderTurnMemoryRollout({
  jobKey,
  input,
  extraction,
  generatedAt,
}: {
  jobKey: string;
  input: TurnMemoryBatchProjection;
  extraction: TurnMemoryExtraction;
  generatedAt: number;
}): RenderedMemoryArtifact {
  const updatedAt = new Date(generatedAt).toISOString();
  const time = input.startedAt.replace(/[:.]/g, "-");
  const stableSuffix = sha256(jobKey).slice(0, 12);
  const relativePath = `rollout_summaries/turn-${time}-${stableSuffix}.md`;
  const title = extraction.turnSlug
    ? extraction.turnSlug.split("-").join(" ")
    : "Turn Memory";
  const sourceFrameIds = [...new Set(
    input.turns.flatMap((turn) => turn.sourceFrameIds),
  )];
  const content = [
    `thread_id: ${inline(input.threadId)}`,
    `session_id: ${inline(input.sessionId)}`,
    `updated_at: ${updatedAt}`,
    `cwd: ${inline(input.cwd)}`,
    `git_branch: ${inline(input.gitBranch)}`,
    `rollout_path: ${inline(input.rolloutPath)}`,
    `rollout_id: ${inline(jobKey)}`,
    field("source_ids", input.sourceIds),
    field("source_frame_ids", sourceFrameIds),
    "",
    `# ${title}`,
    `Turn summary: ${extraction.turnSummary || "(none)"}`,
    `Raw memory: ${extraction.rawMemory || "(none)"}`,
    ...(extraction.tasks.length === 0
      ? ["## Tasks", "(none)"]
      : extraction.tasks.map(taskMarkdown)),
    "",
  ].join("\n");
  return {
    artifactKey: `turn-rollout:${jobKey}`,
    kind: "turn_rollout",
    relativePath,
    content,
    contentHash: sha256(content),
  };
}

export function renderRawMemories(
  inputs: readonly RawMemoryArtifactInput[],
): RenderedMemoryArtifact {
  const content = [
    "# Raw Memories",
    "",
    ...inputs.flatMap((input) => [
      `## ${inline(input.jobKey)}`,
      `rollout_summary_file: ${inline(input.rolloutSummaryFile)}`,
      `Turn summary: ${input.turnSummary || "(none)"}`,
      `Raw memory: ${input.rawMemory || "(none)"}`,
      field(
        "Tasks",
        input.tasks.map((task) => `${task.title} [${task.outcome}]`),
      ),
      "",
    ]),
  ].join("\n");
  return {
    artifactKey: "raw-memories",
    kind: "raw_memories",
    relativePath: "raw_memories.md",
    content,
    contentHash: sha256(content),
  };
}
