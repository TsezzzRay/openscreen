import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import { withMemoryWorkspaceWriter } from "./workspace-coordinator.js";

export interface MemoryArtifactRepository {
  pendingArtifacts(): Array<{
    artifactKey: string;
    relativePath: string;
    content: string;
    contentHash: string;
  }>;
  markArtifactProjected(
    artifactKey: string,
    contentHash: string,
    projectedAt?: number,
  ): boolean;
}

function artifactPath(root: string, relativePath: string): string {
  if (isAbsolute(relativePath)) throw new Error("Memory artifact path must be relative");
  const target = resolve(root, relativePath);
  const fromRoot = relative(resolve(root), target);
  if (fromRoot === ".." || fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new Error("Memory artifact path escapes Memory root");
  }
  return target;
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${randomUUID()}`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
    await chmod(path, 0o600);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function projectPendingMemoryArtifacts(
  root: string,
  repository: MemoryArtifactRepository,
  projectedAt = Date.now(),
): Promise<number> {
  return withMemoryWorkspaceWriter(root, async () => {
    await mkdir(root, { recursive: true, mode: 0o700 });
    await chmod(root, 0o700);
    let count = 0;
    for (const artifact of repository.pendingArtifacts()) {
      await atomicWrite(
        artifactPath(root, artifact.relativePath),
        artifact.content,
      );
      if (repository.markArtifactProjected(
        artifact.artifactKey,
        artifact.contentHash,
        projectedAt,
      )) {
        count += 1;
      }
    }
    return count;
  });
}
