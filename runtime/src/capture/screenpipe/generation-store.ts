import {
  chmod,
  lstat,
  mkdir,
  readdir,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export const DEFAULT_GENERATION_POLICY = {
  maxAgeMilliseconds: 7 * 24 * 60 * 60 * 1000,
  maxBytes: 10 * 1024 * 1024 * 1024,
} as const;

export type GenerationRetentionPolicy = {
  maxAgeMilliseconds: number;
  maxBytes: number;
};

export type GenerationStoreDiagnostic = {
  phase: "generation-retention";
  message: string;
};

export type ScreenpipeGenerationStoreOptions = {
  dataRoot: string;
  policy?: GenerationRetentionPolicy;
  now?: () => Date;
  sizeBytes?: (path: string) => Promise<number>;
  canDeleteGeneration?: (generationId: string) => boolean | Promise<boolean>;
  onDiagnostic?: (diagnostic: GenerationStoreDiagnostic) => void;
};

export type StoredGeneration = {
  generationId: string;
  generationRoot: string;
  generationsRoot: string;
  createdAtMs: number;
};

export type StoredGenerationStatus = {
  generationId: string;
  generationRoot: string;
  active: boolean;
};

const PRIVATE_MODE = 0o700;

function validatePolicy(policy: GenerationRetentionPolicy): void {
  if (!Number.isFinite(policy.maxAgeMilliseconds) || policy.maxAgeMilliseconds <= 0) {
    throw new Error("Generation maxAgeMilliseconds must be positive");
  }
  if (!Number.isFinite(policy.maxBytes) || policy.maxBytes < 0) {
    throw new Error("Generation maxBytes must be non-negative");
  }
}

export function validateGenerationId(value: string): string {
  if (
    typeof value !== "string"
    || value.trim().length === 0
    || value === "."
    || value === ".."
    || value.includes("/")
    || value.includes("\\")
  ) {
    throw new Error("Screenpipe generation id must be a single path segment");
  }
  return value;
}

async function directoryBytes(path: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    const childStats = await lstat(child);
    if (childStats.isSymbolicLink()) continue;
    if (childStats.isDirectory()) {
      total += await directoryBytes(child);
    } else if (childStats.isFile()) {
      total += childStats.size;
    }
  }
  return total;
}

function isWithin(root: string, path: string): boolean {
  const remainder = relative(root, path);
  return remainder !== ".." &&
    !remainder.startsWith(`..${sep}`) &&
    !isAbsolute(remainder);
}

export class ScreenpipeGenerationStore {
  readonly policy: GenerationRetentionPolicy;
  private readonly now: () => Date;
  private readonly sizeBytes: (path: string) => Promise<number>;
  private readonly canDeleteGeneration: (generationId: string) => boolean | Promise<boolean>;
  private readonly onDiagnostic?: (diagnostic: GenerationStoreDiagnostic) => void;

  constructor(private readonly options: ScreenpipeGenerationStoreOptions) {
    this.policy = options.policy ?? DEFAULT_GENERATION_POLICY;
    validatePolicy(this.policy);
    this.now = options.now ?? (() => new Date());
    this.sizeBytes = options.sizeBytes ?? directoryBytes;
    this.canDeleteGeneration = options.canDeleteGeneration ?? (() => true);
    this.onDiagnostic = options.onDiagnostic;
  }

  private roots(): { screenpipeRoot: string; generationsRoot: string } {
    if (!isAbsolute(this.options.dataRoot)) {
      throw new Error("Screenpipe dataRoot must be absolute");
    }
    const screenpipeRoot = join(this.options.dataRoot, "screenpipe");
    return {
      screenpipeRoot,
      generationsRoot: join(screenpipeRoot, "generations"),
    };
  }

  private async ensureRoots(): Promise<{ screenpipeRoot: string; generationsRoot: string }> {
    const roots = this.roots();
    await mkdir(roots.screenpipeRoot, { recursive: true, mode: PRIVATE_MODE });
    const screenpipeStats = await lstat(roots.screenpipeRoot);
    if (!screenpipeStats.isDirectory() || screenpipeStats.isSymbolicLink()) {
      throw new Error("Screenpipe screenpipe root must be a directory");
    }
    await chmod(roots.screenpipeRoot, PRIVATE_MODE);
    await mkdir(roots.generationsRoot, { recursive: true, mode: PRIVATE_MODE });
    const generationsStats = await lstat(roots.generationsRoot);
    if (!generationsStats.isDirectory() || generationsStats.isSymbolicLink()) {
      throw new Error("Screenpipe generations root must be a directory");
    }
    await chmod(roots.generationsRoot, PRIVATE_MODE);
    return roots;
  }

  async createGeneration(generationId: string): Promise<StoredGeneration> {
    const id = validateGenerationId(generationId);
    const { generationsRoot } = await this.ensureRoots();
    const generationRoot = join(generationsRoot, id);
    await mkdir(generationRoot, { mode: PRIVATE_MODE });
    await chmod(generationRoot, PRIVATE_MODE);
    return {
      generationId: id,
      generationRoot,
      generationsRoot,
      createdAtMs: this.now().getTime(),
    };
  }

  async listGenerations(activeGenerationRoot: string): Promise<StoredGenerationStatus[]> {
    const { generationsRoot } = await this.ensureRoots();
    const canonicalGenerationsRoot = await realpath(generationsRoot);
    const canonicalActive = await realpath(resolve(activeGenerationRoot));
    const generations: StoredGenerationStatus[] = [];
    for (const entry of await readdir(generationsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      let generationId: string;
      try {
        generationId = validateGenerationId(entry.name);
      } catch {
        continue;
      }
      const generationRoot = join(generationsRoot, generationId);
      const candidate = await lstat(generationRoot);
      if (!candidate.isDirectory() || candidate.isSymbolicLink()) continue;
      const canonical = await realpath(generationRoot);
      if (
        !isWithin(canonicalGenerationsRoot, canonical) ||
        relative(canonicalGenerationsRoot, canonical).includes(sep)
      ) {
        continue;
      }
      generations.push({
        generationId,
        generationRoot: canonical,
        active: canonical === canonicalActive,
      });
    }
    return generations.sort((left, right) =>
      left.generationId.localeCompare(right.generationId));
  }

  private reportCleanupFailure(): void {
    try {
      this.onDiagnostic?.({
        phase: "generation-retention",
        message: "Generation retention cleanup failed",
      });
    } catch {
      // Diagnostics cannot affect the active generation.
    }
  }

  async retain(activeGenerationRoot: string): Promise<void> {
    try {
      const { generationsRoot } = await this.ensureRoots();
      const canonicalGenerationsRoot = await realpath(generationsRoot);
      const resolvedActive = resolve(activeGenerationRoot);
      const canonicalActive = await realpath(resolvedActive).catch(() => undefined);
      const candidates: Array<{
        generationId: string;
        path: string;
        modifiedAtMs: number;
        bytes: number;
        active: boolean;
      }> = [];
      for (const entry of await readdir(generationsRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        const candidatePath = join(generationsRoot, entry.name);
        const candidateStats = await lstat(candidatePath);
        if (!candidateStats.isDirectory() || candidateStats.isSymbolicLink()) continue;
        const canonicalCandidate = await realpath(candidatePath);
        const canonicalResolvedCandidate = await realpath(resolve(candidatePath));
        if (
          canonicalCandidate !== canonicalResolvedCandidate
          || !isWithin(canonicalGenerationsRoot, canonicalCandidate)
          || relative(canonicalGenerationsRoot, canonicalCandidate).includes(sep)
        ) {
          continue;
        }
        const currentStats = await stat(candidatePath);
        const bytes = await this.sizeBytes(candidatePath);
        candidates.push({
          generationId: entry.name,
          path: candidatePath,
          modifiedAtMs: currentStats.mtimeMs,
          bytes,
          active: canonicalActive !== undefined
            ? canonicalCandidate === canonicalActive
            : resolve(candidatePath) === resolvedActive,
        });
      }

      let totalBytes = candidates.reduce((sum, item) => sum + item.bytes, 0);
      const orderedCandidates = candidates
        .filter((item) => !item.active)
        .sort((left, right) => left.modifiedAtMs - right.modifiedAtMs);
      const ordered: typeof orderedCandidates = [];
      for (const item of orderedCandidates) {
        try {
          if (await this.canDeleteGeneration(item.generationId)) ordered.push(item);
        } catch {
          this.reportCleanupFailure();
        }
      }
      const expired = ordered.filter((item) =>
        this.now().getTime() - item.modifiedAtMs >= this.policy.maxAgeMilliseconds,
      );
      const remove = async (item: typeof candidates[number]): Promise<boolean> => {
        try {
          const current = await lstat(item.path);
          if (!current.isDirectory() || current.isSymbolicLink()) return false;
          await rm(item.path, { recursive: true, force: false });
          totalBytes -= item.bytes;
          return true;
        } catch {
          this.reportCleanupFailure();
          return false;
        }
      };
      for (const item of expired) await remove(item);
      if (totalBytes > this.policy.maxBytes) {
        for (const item of ordered) {
          if (totalBytes <= this.policy.maxBytes) break;
          if (!expired.includes(item)) await remove(item);
        }
      }
    } catch {
      this.reportCleanupFailure();
    }
  }
}
