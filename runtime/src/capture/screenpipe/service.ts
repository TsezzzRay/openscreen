import { constants } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";

import type {
  CapturedFrameContext,
  CaptureService,
} from "../api.js";
import type { ScreenFrameSource } from "./frame-source.js";
import type {
  ScreenpipeCaptureSnapshot,
} from "./runtime.js";

export type ScreenpipeRuntimeLike = {
  start(): Promise<void>;
  stop(): Promise<void>;
  captureSnapshot(): Promise<ScreenpipeCaptureSnapshot>;
};

export type ScreenpipeCaptureServiceOptions = {
  runtime: ScreenpipeRuntimeLike;
};

type LoadedJpeg = {
  imagePath: string;
  data: Uint8Array;
};

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("The operation was aborted", "AbortError");
  }
}

function isWithin(root: string, path: string): boolean {
  const remainder = relative(root, path);
  return remainder !== ".." &&
    !remainder.startsWith(`..${sep}`) &&
    !isAbsolute(remainder);
}

/**
 * The canonical, private generation root is the prerequisite for safely
 * traversing its intermediate directories. O_NOFOLLOW on a leaf open is not
 * fd-relative traversal and cannot replace this invariant.
 */
async function validateGenerationRoot(
  generationRoot: string,
  signal?: AbortSignal,
): Promise<string> {
  const resolvedRoot = resolve(generationRoot);
  try {
    throwIfAborted(signal);
    const rootLink = await lstat(resolvedRoot);
    throwIfAborted(signal);
    if (rootLink.isSymbolicLink()) {
      throw new Error("root is a symlink");
    }
    if (!rootLink.isDirectory()) {
      throw new Error("root is not a directory");
    }
    const canonicalRoot = await realpath(resolvedRoot);
    throwIfAborted(signal);
    if (canonicalRoot !== resolvedRoot) {
      throw new Error("realpath differs from the resolved root");
    }
    const rootStats = await stat(resolvedRoot);
    throwIfAborted(signal);
    if (!rootStats.isDirectory()) {
      throw new Error("root is not a directory");
    }
    const uid = process.getuid?.();
    if (uid !== undefined && rootStats.uid !== uid) {
      throw new Error("root is not owned by the current uid");
    }
    if ((rootStats.mode & 0o077) !== 0) {
      throw new Error("root allows group or world access");
    }
    return canonicalRoot;
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error(
      `Screenpipe generation root security validation failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
}

async function loadJpeg(
  generationRoot: string,
  imagePath: string,
): Promise<LoadedJpeg | undefined> {
  try {
    const candidate = isAbsolute(imagePath)
      ? imagePath
      : resolve(generationRoot, imagePath);
    const canonicalPath = await realpath(candidate);
    if (!isWithin(generationRoot, canonicalPath)) return undefined;
    if (!/\.jpe?g$/i.test(extname(canonicalPath))) return undefined;

    const flags = constants.O_RDONLY |
      (typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0);
    const file = await open(canonicalPath, flags);
    try {
      if (!(await file.stat()).isFile()) return undefined;
      const data = await file.readFile();
      return data.length >= 2 && data[0] === 0xff && data[1] === 0xd8
        ? { imagePath: canonicalPath, data }
        : undefined;
    } finally {
      await file.close();
    }
  } catch {
    return undefined;
  }
}

export class ScreenpipeCaptureService implements CaptureService {
  constructor(private readonly options: ScreenpipeCaptureServiceOptions) {}

  start(): Promise<void> {
    return this.options.runtime.start();
  }

  stop(): Promise<void> {
    return this.options.runtime.stop();
  }

  async capture(
    _requestId: string,
    signal?: AbortSignal,
  ): Promise<CapturedFrameContext> {
    throwIfAborted(signal);
    const snapshot = await this.options.runtime.captureSnapshot();
    throwIfAborted(signal);
    const generationRoot = await validateGenerationRoot(
      snapshot.generation.generationRoot,
      signal,
    );

    const frames: ScreenFrameSource[] = [];
    const images: NonNullable<CapturedFrameContext["images"]> = [];
    for (const frame of snapshot.frames) {
      throwIfAborted(signal);
      if (frame.generationId !== snapshot.generation.generationId) continue;
      const image = await loadJpeg(generationRoot, frame.imagePath);
      throwIfAborted(signal);
      if (image === undefined) continue;
      frames.push({ ...frame, imagePath: image.imagePath });
      images.push({
        sourceId: frame.sourceId,
        data: image.data,
        mimeType: "image/jpeg",
      });
    }
    throwIfAborted(signal);
    return { type: "frames", frames, images };
  }
}
