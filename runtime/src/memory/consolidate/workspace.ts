import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, chmod } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const ROOT_MARKER = ".openscreen-memory-root";
const ROOT_MARKER_CONTENTS = "openscreen-memory-root-v1\n";
const GIT_IGNORE = `memory.sqlite3
memory.sqlite3-*
evidence/
screenpipe/
.consolidation-staging/
.DS_Store
**/.DS_Store
`;
const MANIFEST_FILES = new Set([
  ROOT_MARKER,
  ".gitignore",
  "MEMORY.md",
  "memory_summary.md",
  "raw_memories.md",
]);
const PREEXISTING_PRIVATE_ENTRY = /^(?:memory\.sqlite3(?:-.+)?|evidence|screenpipe|\.consolidation-staging)$/;

async function git(
  root: string,
  args: string[],
  allowDifference = false,
): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFileAsync("git", args, {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    if (
      allowDifference &&
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === 1 &&
      "stdout" in error &&
      typeof error.stdout === "string"
    ) {
      return { stdout: error.stdout, stderr: "" };
    }
    throw error;
  }
}

async function pathExists(path: string): Promise<boolean> {
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

async function atomicWrite(path: string, contents: string): Promise<void> {
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

function isManifestPath(path: string): boolean {
  return MANIFEST_FILES.has(path) ||
    /^rollout_summaries\/[^/]+\.md$/.test(path);
}

async function validateManifestPaths(root: string): Promise<string[]> {
  const output = (await git(root, [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "-z",
  ])).stdout;
  const paths = output.split("\0").filter(Boolean);
  for (const path of paths) {
    if (!isManifestPath(path)) {
      throw new Error(`Memory Git manifest rejects path ${path}`);
    }
    const absolute = join(root, path);
    try {
      const info = await lstat(absolute);
      if (!info.isFile() || info.isSymbolicLink()) {
        throw new Error(`Memory Git manifest requires a regular file: ${path}`);
      }
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        continue;
      }
      throw error;
    }
  }
  return paths;
}

async function assertNoRemotes(root: string): Promise<void> {
  const remotes = (await git(root, ["remote"])).stdout.trim();
  if (remotes) throw new Error("OpenScreen Memory Git repository must not have remotes");
}

async function assertOwnedRepository(root: string): Promise<void> {
  const expectedRoot = await realpath(root);
  const topLevel = await realpath(resolve(
    (await git(root, ["rev-parse", "--show-toplevel"])).stdout.trim(),
  ));
  const gitDirectory = await realpath(resolve(
    (await git(root, ["rev-parse", "--absolute-git-dir"])).stdout.trim(),
  ));
  const owned = (await git(root, [
    "config",
    "--local",
    "--get",
    "openscreen.memoryRoot",
  ])).stdout.trim();
  if (
    topLevel !== expectedRoot ||
    gitDirectory !== join(expectedRoot, ".git") ||
    owned !== "true"
  ) {
    throw new Error("Memory workspace must use an OpenScreen-owned dedicated Git repository");
  }
  await assertNoRemotes(root);
}

async function validateDedicatedContents(root: string): Promise<void> {
  const allowed = new Set([
    ...MANIFEST_FILES,
    "rollout_summaries",
  ]);
  const foreign = (await readdir(root))
    .filter((entry) => !allowed.has(entry) && !PREEXISTING_PRIVATE_ENTRY.test(entry));
  if (foreign.length > 0) {
    throw new Error(
      `OpenScreen Memory requires a dedicated directory; found ${foreign.join(", ")}`,
    );
  }
}

async function verifyMarker(root: string): Promise<void> {
  const marker = await readFile(join(root, ROOT_MARKER), "utf8").catch(() => undefined);
  if (marker !== ROOT_MARKER_CONTENTS) {
    throw new Error("Invalid or missing OpenScreen-owned Memory root marker");
  }
}

async function expirePreviousBaseline(root: string): Promise<void> {
  await git(root, [
    "reflog",
    "expire",
    "--expire=now",
    "--expire-unreachable=now",
    "--all",
  ]);
  await git(root, ["gc", "--quiet", "--prune=now"]);
}

async function createParentlessBaseline(
  root: string,
  expectedHead?: string,
): Promise<string> {
  await assertOwnedRepository(root);
  await validateManifestPaths(root);
  let current: string | undefined;
  try {
    current = (await git(root, ["rev-parse", "--verify", "HEAD"])).stdout.trim();
  } catch {
    current = undefined;
  }
  if (expectedHead !== undefined && current !== expectedHead) {
    throw new Error("Memory Git compare-and-swap failed because HEAD changed");
  }
  if (expectedHead === undefined && current !== undefined) {
    throw new Error("Memory Git baseline already exists");
  }
  await git(root, ["add", "-A"]);
  const tree = (await git(root, ["write-tree"])).stdout.trim();
  const commit = (await git(root, [
    "-c",
    "user.name=OpenScreen Memory",
    "-c",
    "user.email=memory@openscreen.local",
    "commit-tree",
    tree,
    "-m",
    "memory baseline",
  ])).stdout.trim();
  const reference = (await git(root, ["symbolic-ref", "HEAD"])).stdout.trim();
  await git(root, [
    "update-ref",
    reference,
    commit,
    ...(current === undefined ? [] : [current]),
  ]);
  await git(root, ["reset", "--hard", commit]);
  await expirePreviousBaseline(root);
  return commit;
}

export async function prepareMemoryWorkspace(root: string): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  const hasGit = await pathExists(join(root, ".git"));
  if (hasGit) {
    await verifyMarker(root);
    await assertOwnedRepository(root);
  } else {
    await validateDedicatedContents(root);
    if (await pathExists(join(root, ROOT_MARKER))) await verifyMarker(root);
    else await atomicWrite(join(root, ROOT_MARKER), ROOT_MARKER_CONTENTS);
  }
  const ignorePath = join(root, ".gitignore");
  if (await readFile(ignorePath, "utf8").catch(() => undefined) !== GIT_IGNORE) {
    await atomicWrite(ignorePath, GIT_IGNORE);
  }
  if (!hasGit) {
    await git(root, ["init", "--quiet"]);
    await git(root, ["config", "--local", "openscreen.memoryRoot", "true"]);
    await createParentlessBaseline(root);
    return;
  }
  try {
    await git(root, ["rev-parse", "--verify", "HEAD"]);
  } catch {
    await createParentlessBaseline(root);
  }
  await validateManifestPaths(root);
}

export async function memoryWorkspaceHead(root: string): Promise<string> {
  await assertOwnedRepository(root);
  return (await git(root, ["rev-parse", "--verify", "HEAD"])).stdout.trim();
}

export async function memoryWorkspaceDiff(
  root: string,
): Promise<{ hasChanges: boolean; diff: string }> {
  await assertOwnedRepository(root);
  await validateManifestPaths(root);
  const status = (await git(root, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ])).stdout;
  if (!status.trim()) return { hasChanges: false, diff: "" };
  let diff = (await git(root, [
    "diff",
    "--no-ext-diff",
    "--no-color",
    "HEAD",
    "--",
    ".",
  ])).stdout;
  const tracked = new Set((await git(root, ["ls-files", "-z"])).stdout
    .split("\0")
    .filter(Boolean));
  const manifestPaths = await validateManifestPaths(root);
  for (const path of manifestPaths.filter((candidate) => !tracked.has(candidate))) {
    diff += (await git(root, [
      "diff",
      "--no-index",
      "--no-color",
      "--",
      "/dev/null",
      join(root, path),
    ], true)).stdout;
  }
  return { hasChanges: true, diff };
}

export async function publishMemoryWorkspaceBaseline(
  root: string,
  expectedHead: string,
): Promise<string> {
  if (!/^[0-9a-f]{40,64}$/.test(expectedHead)) {
    throw new Error("Invalid expected Memory Git HEAD");
  }
  return createParentlessBaseline(root, expectedHead);
}

export async function rollbackMemoryWorkspace(root: string): Promise<void> {
  await assertOwnedRepository(root);
  const manifestPaths = await validateManifestPaths(root);
  const tracked = new Set((await git(root, ["ls-files", "-z"])).stdout
    .split("\0")
    .filter(Boolean));
  for (const path of manifestPaths) {
    if (!tracked.has(path)) await rm(join(root, path), { force: true });
  }
  await git(root, ["reset", "--hard", "HEAD"]);
  await validateManifestPaths(root);
}
