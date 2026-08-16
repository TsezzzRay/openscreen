import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";

import {
  hasApi,
  type Model,
  type Models,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";

import {
  buildConsolidationContext,
  CONSOLIDATION_TOOL_NAME,
  estimateConsolidationInputTokens,
  parseConsolidationOutput,
  renderConsolidatedMemory,
  validateConsolidationOutput,
} from "./model-projection.js";
import type {
  ConsolidationPublication,
  ConsolidationRepository,
} from "./repository.js";
import {
  memoryWorkspaceDiff,
  memoryWorkspaceHead,
  prepareMemoryWorkspace,
  publishMemoryWorkspaceBaseline,
  rollbackMemoryWorkspace,
} from "./workspace.js";
import {
  freezeMemoryWorkspace,
  type FrozenMemoryWorkspace,
} from "../workspace-coordinator.js";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readOptional(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

function validMemory(memory: string, summary: string): boolean {
  return memory.startsWith("# ") && summary.split(/\r?\n/, 1)[0] === "v1";
}

async function stagePublication(
  root: string,
  memory: string,
  summary: string,
): Promise<{
  stagingName: string;
  directory: string;
  memoryPath: string;
  summaryPath: string;
  memorySha256: string;
  summarySha256: string;
}> {
  const stagingName = randomUUID();
  const directory = join(root, ".consolidation-staging", stagingName);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const memoryPath = join(directory, "MEMORY.md");
  const summaryPath = join(directory, "memory_summary.md");
  for (const [path, content] of [[memoryPath, memory], [summaryPath, summary]] as const) {
    const file = await open(path, "wx", 0o600);
    try {
      await file.writeFile(content, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
  }
  return {
    stagingName,
    directory,
    memoryPath,
    summaryPath,
    memorySha256: sha256(memory),
    summarySha256: sha256(summary),
  };
}

async function publicationIsBaseline(
  root: string,
  publication: ConsolidationPublication,
): Promise<boolean> {
  const memory = await readOptional(join(root, "MEMORY.md"));
  const summary = await readOptional(join(root, "memory_summary.md"));
  return sha256(memory) === publication.memorySha256 &&
    sha256(summary) === publication.summarySha256 &&
    validMemory(memory, summary) &&
    !(await memoryWorkspaceDiff(root)).hasChanges;
}

async function recoverWithinFreeze(
  root: string,
  repository: ConsolidationRepository,
  frozen: FrozenMemoryWorkspace,
  now: number,
): Promise<"none" | "finalized" | "rolled_back"> {
  const publication = repository.publication();
  if (publication === null) return "none";
  const result = await frozen.runExclusive(async () => {
    if (await publicationIsBaseline(root, publication)) {
      if (!repository.recoverPublished(publication, now)) {
        throw new Error("Consolidation publication recovery lost SQLite ownership");
      }
      return "finalized" as const;
    }
    await rollbackMemoryWorkspace(root);
    if (!repository.abandonPublication(
      publication.ownershipToken,
      "Rolled back incomplete Memory publication",
    )) {
      throw new Error("Consolidation rollback lost SQLite ownership");
    }
    return "rolled_back" as const;
  });
  await rm(join(root, ".consolidation-staging", publication.stagingName), {
    recursive: true,
    force: true,
  });
  return result;
}

export async function recoverConsolidationPublication({
  root,
  repository,
  now = Date.now,
  projectNewerSources,
}: {
  root: string;
  repository: ConsolidationRepository;
  now?: () => number;
  projectNewerSources?: () => Promise<void>;
}): Promise<"none" | "finalized" | "rolled_back"> {
  await prepareMemoryWorkspace(root);
  const publication = repository.publication();
  if (publication === null) return "none";
  const frozen = await freezeMemoryWorkspace(
    root,
    `recovery:${publication.ownershipToken}`,
  );
  try {
    return await recoverWithinFreeze(root, repository, frozen, now());
  } finally {
    await frozen.release();
    await projectNewerSources?.();
  }
}

export type ConsolidationPublicationPhase = "artifacts_published" | "baseline_published";

export async function processConsolidation({
  root,
  repository,
  models,
  model,
  workerId,
  now = Date.now,
  signal,
  projectNewerSources,
  onPublicationPhase,
}: {
  root: string;
  repository: ConsolidationRepository;
  models: Models;
  model: Model<string>;
  workerId: string;
  now?: () => number;
  signal?: AbortSignal;
  projectNewerSources?: () => Promise<void>;
  onPublicationPhase?: (phase: ConsolidationPublicationPhase) => void;
}): Promise<
  | { status: "skipped"; reason: string }
  | { status: "no_changes" }
  | { status: "processed"; recovered?: true }
  | { status: "failed"; error: string }
> {
  const recovery = await recoverConsolidationPublication({
    root,
    repository,
    now,
    projectNewerSources,
  });
  if (recovery === "finalized") return { status: "processed", recovered: true };
  const claimed = repository.claim(workerId, now());
  if (claimed.status !== "claimed") {
    return { status: "skipped", reason: claimed.reason };
  }
  const claim = claimed.claim;
  const frozen = await freezeMemoryWorkspace(root, claim.ownershipToken);
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const heartbeat = setInterval(() => {
    if (!repository.heartbeat(claim, now())) {
      controller.abort("Consolidation ownership lost");
    }
  }, Math.max(1_000, Math.floor(repository.config.worker.leaseMilliseconds / 3)));
  heartbeat.unref();
  try {
    const inputs = repository.loadInputs(claim);
    let expectedHead = "";
    let diff = { hasChanges: false, diff: "" };
    await frozen.runExclusive(async () => {
      await prepareMemoryWorkspace(root);
      for (const input of inputs) {
        if (input.state === "removed") {
          await rm(join(root, input.artifactPath), { force: true });
        }
      }
      expectedHead = await memoryWorkspaceHead(root);
      diff = await memoryWorkspaceDiff(root);
    });
    const currentMemory = await readOptional(join(root, "MEMORY.md"));
    const currentSummary = await readOptional(join(root, "memory_summary.md"));
    const changedInputs = inputs.filter(({ state }) => state !== "retained");
    if (
      changedInputs.length === 0 &&
      !diff.hasChanges &&
      validMemory(currentMemory, currentSummary)
    ) {
      if (!repository.succeed(claim, undefined, now())) {
        throw new Error("Consolidation ownership lost");
      }
      return { status: "no_changes" };
    }
    const sourceContents = new Map<string, string>();
    for (const input of changedInputs) {
      if (input.state === "removed") continue;
      const content = await readOptional(join(root, input.artifactPath));
      if (!content) {
        throw new Error(`Missing Memory rollout artifact ${input.artifactPath}`);
      }
      if (sha256(content) !== input.contentHash) {
        throw new Error(`Memory rollout artifact hash mismatch ${input.artifactPath}`);
      }
      sourceContents.set(input.sourceKey, content);
    }
    const context = buildConsolidationContext({
      currentMemory,
      currentSummary,
      workspaceDiff: diff.diff,
      inputs,
      activeEvidenceManifest: repository.activeEvidenceManifest(claim),
      sourceContents,
    });
    const inputTokens = estimateConsolidationInputTokens(context);
    if (inputTokens > repository.config.consolidation.maxInputTokens) {
      throw new Error(
        `Consolidation input exceeds its token budget (${inputTokens} > ${repository.config.consolidation.maxInputTokens})`,
      );
    }
    const options = {
      maxTokens: repository.config.consolidation.maxOutputTokens,
      temperature: 0,
      cacheRetention: "none",
      signal: controller.signal,
    } satisfies SimpleStreamOptions;
    const response = hasApi(model, "anthropic-messages")
      ? await models.complete(model, context, {
          ...options,
          toolChoice: { type: "tool", name: CONSOLIDATION_TOOL_NAME },
        })
      : await models.completeSimple(model, context, options);
    if (response.stopReason === "error" || response.stopReason === "aborted") {
      throw new Error(
        response.errorMessage ?? `Consolidation model stopped with ${response.stopReason}`,
      );
    }
    if (response.stopReason !== "toolUse") {
      throw new Error(
        `Consolidation model must return exactly one consolidation tool call; stopped with ${response.stopReason}`,
      );
    }
    const toolCalls = response.content.filter((block) => block.type === "toolCall");
    if (toolCalls.length !== 1) {
      throw new Error("Consolidation model must return exactly one consolidation tool call");
    }
    const toolCall = toolCalls[0]!;
    if (toolCall.name !== CONSOLIDATION_TOOL_NAME) {
      throw new Error(`Unexpected consolidation tool ${toolCall.name}`);
    }
    const output = validateConsolidationOutput(
      parseConsolidationOutput(toolCall.arguments),
      inputs,
    );
    const byPath = new Map(inputs.map((input) => [input.artifactPath, input]));
    for (const path of new Set(output.taskGroups.flatMap(({ tasks }) =>
      tasks.flatMap(({ rolloutSummaryFiles }) => rolloutSummaryFiles)
    ))) {
      const content = await readOptional(join(root, path));
      if (!content || sha256(content) !== byPath.get(path)?.contentHash) {
        throw new Error(`Consolidated Memory references an invalid rollout ${path}`);
      }
    }
    const rendered = renderConsolidatedMemory(
      output,
      inputs,
      repository.config.consolidation.summaryMaxTokens,
    );
    const staged = await stagePublication(root, rendered.memory, rendered.summary);
    const evidence = Object.fromEntries(output.evidence);
    if (!repository.preparePublication(claim, {
      stagingName: staged.stagingName,
      expectedHead,
      memorySha256: staged.memorySha256,
      summarySha256: staged.summarySha256,
      evidence,
      createdAt: now(),
    }, now())) {
      throw new Error("Consolidation ownership lost before publication");
    }
    await frozen.runExclusive(async () => {
      if (!repository.heartbeat(claim, now()) ||
          await memoryWorkspaceHead(root) !== expectedHead ||
          !repository.beginPublication(claim, now())) {
        throw new Error("Consolidation ownership or frozen workspace changed");
      }
      const memoryPath = join(root, "MEMORY.md");
      const summaryPath = join(root, "memory_summary.md");
      await rename(staged.memoryPath, memoryPath);
      await chmod(memoryPath, 0o600);
      await rename(staged.summaryPath, summaryPath);
      await chmod(summaryPath, 0o600);
      const directory = await open(root, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
      const publishedMemory = await readFile(memoryPath, "utf8");
      const publishedSummary = await readFile(summaryPath, "utf8");
      if (
        sha256(publishedMemory) !== staged.memorySha256 ||
        sha256(publishedSummary) !== staged.summarySha256 ||
        !validMemory(publishedMemory, publishedSummary)
      ) {
        throw new Error("Published consolidation artifacts failed validation");
      }
      onPublicationPhase?.("artifacts_published");
      await publishMemoryWorkspaceBaseline(root, expectedHead);
      onPublicationPhase?.("baseline_published");
      if (!repository.finishPublication(claim, output.evidence, now())) {
        throw new Error("Consolidation ownership lost after publication");
      }
    });
    await rm(staged.directory, { recursive: true, force: true });
    return { status: "processed" };
  } catch (error) {
    const message = errorMessage(error);
    try {
      const recovered = await recoverWithinFreeze(
        root,
        repository,
        frozen,
        now(),
      );
      if (recovered === "finalized") return { status: "processed", recovered: true };
      if (recovered === "none") repository.fail(claim, message, now());
    } catch (recoveryError) {
      repository.fail(
        claim,
        `${message}; publication recovery failed: ${errorMessage(recoveryError)}`,
        now(),
      );
    }
    return { status: "failed", error: message };
  } finally {
    clearInterval(heartbeat);
    signal?.removeEventListener("abort", abort);
    await frozen.release();
    await projectNewerSources?.();
  }
}
