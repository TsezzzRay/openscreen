import { randomUUID } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import {
  existsSync,
  realpathSync,
} from "node:fs";
import {
  access,
  chmod,
  lstat,
  mkdir,
  open,
  realpath,
  readdir,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import { promisify } from "node:util";
import { dirname, join, relative, resolve } from "node:path";

import type { ConsolidationInput } from "./repository.js";

const execFileAsync = promisify(execFile);
const ROOT_MARKER = ".openscreen-memory-root";
const ROOT_MARKER_CONTENTS = "openscreen-memory-root-v1\n";
const GIT_IGNORE = `memory.sqlite3
memory.sqlite3-*
evidence/
.consolidation-staging/
.DS_Store
**/.DS_Store
`;

async function atomicWrite(path: string, contents: string) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(contents, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await rename(temporary, path);
    await chmod(path, 0o600);
    const directory = await open(dirname(path), "r").catch(() => undefined);
    try {
      await directory?.sync();
    } finally {
      await directory?.close();
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

async function git(root: string, args: string[], allowDifference = false) {
  try {
    return await execFileAsync("git", args, {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    if (allowDifference &&
        error && typeof error === "object" &&
        "code" in error && error.code === 1 &&
        "stdout" in error && typeof error.stdout === "string") {
      return { stdout: error.stdout, stderr: "" };
    }
    throw error;
  }
}

async function pathExists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function assertOwnedRepository(root: string) {
  const expectedRoot = await realpath(root);
  const topLevel = await realpath(resolve((await git(root, [
    "rev-parse", "--show-toplevel",
  ])).stdout.trim()));
  const gitDirectory = await realpath(resolve((await git(root, [
    "rev-parse", "--absolute-git-dir",
  ])).stdout.trim()));
  const owned = (await git(root, [
    "config", "--local", "--get", "openscreen.memoryRoot",
  ])).stdout.trim();
  if (topLevel !== expectedRoot ||
      gitDirectory !== resolve(expectedRoot, ".git") ||
      owned !== "true") {
    throw new Error("Memory workspace must use an OpenScreen-owned dedicated Git repository");
  }
}

function gitSync(root: string, args: string[]) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

function assertOwnedRepositorySync(root: string) {
  const expectedRoot = realpathSync(root);
  const topLevel = realpathSync(resolve(
    gitSync(root, ["rev-parse", "--show-toplevel"]).trim(),
  ));
  const gitDirectory = realpathSync(resolve(gitSync(root, [
    "rev-parse", "--absolute-git-dir",
  ]).trim()));
  const owned = gitSync(root, [
    "config", "--local", "--get", "openscreen.memoryRoot",
  ]).trim();
  if (topLevel !== expectedRoot ||
      gitDirectory !== resolve(expectedRoot, ".git") ||
      owned !== "true") {
    throw new Error("Memory workspace must use an OpenScreen-owned dedicated Git repository");
  }
}

async function markDedicatedRoot(root: string) {
  const markerPath = join(root, ROOT_MARKER);
  if (await pathExists(markerPath)) {
    if (await readFile(markerPath, "utf8") !== ROOT_MARKER_CONTENTS) {
      throw new Error("Invalid OpenScreen memory root marker");
    }
    return;
  }
  const allowed = /^(memory\.sqlite3(?:-(?:wal|shm))?|evidence|\.consolidation-staging)$/;
  const foreign = (await readdir(root)).filter((entry) => !allowed.test(entry));
  if (foreign.length > 0) {
    throw new Error(
      `OpenScreen memory requires a dedicated directory; found ${foreign.join(", ")}`,
    );
  }
  await atomicWrite(markerPath, ROOT_MARKER_CONTENTS);
}

async function initializeBaseline(root: string) {
  if (await pathExists(join(root, ".git"))) {
    await assertOwnedRepository(root);
  } else {
    await git(root, ["init", "--quiet"]);
    await git(root, ["config", "--local", "openscreen.memoryRoot", "true"]);
  }
  await git(root, ["add", "-A"]);
  const tree = (await git(root, ["write-tree"])).stdout.trim();
  const commit = (await git(root, [
    "-c", "user.name=OpenScreen Memory",
    "-c", "user.email=memory@openscreen.local",
    "commit-tree", tree, "-m", "memory baseline",
  ])).stdout.trim();
  const reference = (await git(root, ["symbolic-ref", "HEAD"])).stdout.trim();
  let previous: string | undefined;
  try {
    previous = (await git(root, ["rev-parse", "--verify", "HEAD"])).stdout.trim();
  } catch {
    previous = undefined;
  }
  await git(root, [
    "update-ref", reference, commit,
    ...(previous ? [previous] : []),
  ]);
  await git(root, ["reset", "--hard", commit]);
  await git(root, [
    "reflog", "expire", "--expire=now", "--expire-unreachable=now", "--all",
  ]);
  await git(root, ["gc", "--quiet", "--prune=now"]);
}

function initializeBaselineSync(root: string) {
  if (existsSync(join(root, ".git"))) {
    assertOwnedRepositorySync(root);
  } else {
    gitSync(root, ["init", "--quiet"]);
    gitSync(root, ["config", "--local", "openscreen.memoryRoot", "true"]);
  }
  gitSync(root, ["add", "-A"]);
  const tree = gitSync(root, ["write-tree"]).trim();
  const commit = gitSync(root, [
    "-c", "user.name=OpenScreen Memory",
    "-c", "user.email=memory@openscreen.local",
    "commit-tree", tree, "-m", "memory baseline",
  ]).trim();
  const reference = gitSync(root, ["symbolic-ref", "HEAD"]).trim();
  let previous: string | undefined;
  try {
    previous = gitSync(root, ["rev-parse", "--verify", "HEAD"]).trim();
  } catch {
    previous = undefined;
  }
  gitSync(root, [
    "update-ref", reference, commit,
    ...(previous ? [previous] : []),
  ]);
  gitSync(root, ["reset", "--hard", commit]);
  gitSync(root, [
    "reflog", "expire", "--expire=now", "--expire-unreachable=now", "--all",
  ]);
  gitSync(root, ["gc", "--quiet", "--prune=now"]);
}

export async function prepareMemoryWorkspace(root: string) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  await markDedicatedRoot(root);
  const ignorePath = join(root, ".gitignore");
  try {
    if (await readFile(ignorePath, "utf8") !== GIT_IGNORE) {
      await atomicWrite(ignorePath, GIT_IGNORE);
    }
  } catch {
    await atomicWrite(ignorePath, GIT_IGNORE);
  }
  if (await pathExists(join(root, ".git"))) {
    await assertOwnedRepository(root);
    try {
      await git(root, ["rev-parse", "--verify", "HEAD"]);
    } catch {
      await initializeBaseline(root);
    }
  } else {
    await initializeBaseline(root);
  }
}

function renderSourceSummary(input: ConsolidationInput) {
  const title = input.sourceKind === "chronicle"
    ? "Chronicle Activity Summary"
    : "Turn Memory Summary";
  return `# ${title}

- job_key: ${input.jobKey}
- source_kind: ${input.sourceKind}
- provenance: ${input.provenance}
- started_at: ${new Date(input.startedAt).toISOString()}
- ended_at: ${new Date(input.endedAt).toISOString()}
- source_id: ${input.sourceId}
- source_generation: ${input.sourceGeneration}
- source_updated_at: ${input.sourceUpdatedAt}
- generated_at: ${new Date(input.generatedAt).toISOString()}
- scope_hints: ${JSON.stringify(input.scopeHints)}
- evidence_source_ids: ${JSON.stringify(input.sourceIds)}

${input.sourceSummary.trim()}
`;
}

function renderRawMemories(inputs: ConsolidationInput[]) {
  const candidates = inputs.filter((input) =>
    input.sourceKind === "turn_memory" &&
    input.state !== "removed" &&
    Boolean(input.rawMemory));
  if (candidates.length === 0) {
    return "# Raw Memories\n\n_No durable memory candidates._\n";
  }
  return `# Raw Memories

${candidates.map((input) => `## ${input.jobKey}

- source_kind: ${input.sourceKind}
- source_id: ${input.sourceId}
- source_generation: ${input.sourceGeneration}
- source_updated_at: ${input.sourceUpdatedAt}
- generated_at: ${new Date(input.generatedAt).toISOString()}
- scope_hints: ${JSON.stringify(input.scopeHints)}

${input.rawMemory!.trim()}`).join("\n\n")}
`;
}

async function removeStaleSummaries(directory: string, desired: Set<string>) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".md") && !desired.has(entry.name)) {
      await rm(join(directory, entry.name));
    }
  }
}

export async function syncConsolidationInputs(root: string, values: ConsolidationInput[]) {
  const inputs = [...values].sort((left, right) =>
    left.jobKey.localeCompare(right.jobKey));
  const summariesRoot = join(root, "rollout_summaries");
  await mkdir(summariesRoot, { recursive: true, mode: 0o700 });
  const desired = new Set<string>();
  const sourceSummaryFiles: string[] = [];
  for (const input of inputs.filter(({ state }) => state !== "removed")) {
    if (!input.artifactPath.startsWith("rollout_summaries/") ||
        !input.artifactPath.endsWith(".md") ||
        input.artifactPath.slice("rollout_summaries/".length).includes("/")) {
      throw new Error(`Invalid Consolidation artifact path ${input.artifactPath}`);
    }
    const filename = input.artifactPath.slice("rollout_summaries/".length);
    desired.add(filename);
    const path = join(summariesRoot, filename);
    await atomicWrite(path, renderSourceSummary(input));
    sourceSummaryFiles.push(relative(root, path));
  }
  await removeStaleSummaries(summariesRoot, desired);
  await atomicWrite(join(root, "raw_memories.md"), renderRawMemories(inputs));
  return { sourceSummaryFiles };
}

async function exists(path: string) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function memoryWorkspaceDiff(root: string) {
  const status = (await git(root, [
    "status", "--porcelain=v1", "--untracked-files=all",
  ])).stdout;
  if (!status.trim()) return { hasChanges: false, diff: "" };
  let diff = (await git(root, [
    "diff", "--no-ext-diff", "--no-color", "HEAD", "--", ".",
  ])).stdout;
  const untracked = status.split("\n")
    .filter((line) => line.startsWith("?? "))
    .map((line) => line.slice(3));
  for (const path of untracked) {
    const absolute = join(root, path);
    if (!await exists(absolute)) continue;
    diff += (await git(root, [
      "diff", "--no-index", "--no-color", "--", "/dev/null", absolute,
    ], true)).stdout;
  }
  return { hasChanges: true, diff };
}

export async function resetMemoryWorkspaceBaseline(root: string) {
  await initializeBaseline(root);
}

export function resetMemoryWorkspaceBaselineSync(root: string) {
  initializeBaselineSync(root);
}

export async function rollbackMemoryWorkspace(root: string) {
  await assertOwnedRepository(root);
  await git(root, ["reset", "--hard", "HEAD"]);
  await git(root, ["clean", "-fd"]);
}
