import { mkdtemp, open, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  CapturedFrame,
  CapturedFrameContext,
  CapturedFrameImage,
  CaptureService,
} from "../api.js";
import { type HelperReport, type RunHelper, runHelper } from "./helper.js";

export type NativeCaptureOptions = {
  helperPath: string;
  /** Fraction of each display's logical size. 1.0 stays legible at ~200 KB. */
  scale?: number;
  quality?: number;
  maxTextCharacters?: number;
  /** Bundle identifiers cut out of the capture — the assistant's own windows. */
  excludeBundleIds?: readonly string[];
  timeoutMilliseconds?: number;
  run?: RunHelper;
  makeTempDir?: () => Promise<string>;
};

const DEFAULTS = {
  scale: 1,
  quality: 0.6,
  maxTextCharacters: 8_000,
  timeoutMilliseconds: 5_000,
};

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("The operation was aborted", "AbortError");
  }
}

async function readJpeg(path: string): Promise<Uint8Array | undefined> {
  try {
    const flags = constants.O_RDONLY |
      (typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0);
    const file = await open(path, flags);
    try {
      if (!(await file.stat()).isFile()) return undefined;
      const data = await file.readFile();
      return data.length >= 2 && data[0] === 0xff && data[1] === 0xd8 ? data : undefined;
    } finally {
      await file.close();
    }
  } catch {
    return undefined;
  }
}

/**
 * Projects one helper run into frames.
 *
 * The window identity and its text belong to exactly one display — the one the
 * focused window sits on — so they are attached there and nowhere else. A frame
 * that claimed the focused window's text while showing a different screen is
 * the failure this whole path exists to remove.
 */
export function projectReport(report: HelperReport, captureId: string): CapturedFrame[] {
  const frames: CapturedFrame[] = [];
  for (const display of report.displays) {
    if (display.path === undefined) continue;
    const monitorKey = String(display.displayId);
    const isFocusedDisplay = display.focused && report.focused !== undefined;
    frames.push({
      sourceId: `native-capture:${captureId}:${monitorKey}`,
      generationId: captureId,
      frameId: monitorKey,
      monitorKey,
      deviceName: `Display ${monitorKey}`,
      capturedAt: report.capturedAt,
      trigger: "prompt",
      imagePath: display.path,
      focused: display.focused,
      ...(isFocusedDisplay && report.focused?.appName !== undefined
        ? { application: report.focused.appName }
        : {}),
      ...(isFocusedDisplay && report.focused?.windowTitle !== undefined
        ? { windowTitle: report.focused.windowTitle }
        : {}),
      ...(isFocusedDisplay && report.focused?.text !== undefined
        ? { visibleText: report.focused.text }
        : {}),
    });
  }
  return frames.sort((left, right) => Number(left.monitorKey) - Number(right.monitorKey));
}

/**
 * Reads the screen at the moment a prompt is submitted.
 *
 * The recorder that keeps the background activity history cannot answer this:
 * its newest stored frame trails the question and can name a window the user
 * already left. This spawns the helper instead, so the pixels and the window's
 * text are both from the instant the user pressed enter.
 */
export class NativeCaptureService implements CaptureService {
  private readonly run: RunHelper;
  private readonly makeTempDir: () => Promise<string>;

  constructor(private readonly options: NativeCaptureOptions) {
    this.run = options.run ?? runHelper;
    this.makeTempDir = options.makeTempDir ??
      (() => mkdtemp(join(tmpdir(), "openscreen-capture-")));
  }

  // Nothing runs between prompts: the helper is spawned per capture and exits.
  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  async capture(_requestId: string, signal?: AbortSignal): Promise<CapturedFrameContext> {
    throwIfAborted(signal);
    const outDir = await this.makeTempDir();
    try {
      const report = await this.run(
        {
          helperPath: this.options.helperPath,
          outDir,
          scale: this.options.scale ?? DEFAULTS.scale,
          quality: this.options.quality ?? DEFAULTS.quality,
          maxTextCharacters: this.options.maxTextCharacters ?? DEFAULTS.maxTextCharacters,
          excludeBundleIds: this.options.excludeBundleIds ?? [],
          timeoutMilliseconds: this.options.timeoutMilliseconds ??
            DEFAULTS.timeoutMilliseconds,
        },
        signal,
      );
      throwIfAborted(signal);

      const captureId = report.capturedAt;
      const frames: CapturedFrame[] = [];
      const images: CapturedFrameImage[] = [];
      for (const frame of projectReport(report, captureId)) {
        throwIfAborted(signal);
        const data = await readJpeg(frame.imagePath);
        if (data === undefined) continue;
        frames.push(frame);
        images.push({ sourceId: frame.sourceId, data, mimeType: "image/jpeg" });
      }
      return { type: "frames", frames, images };
    } finally {
      // The bytes are in memory by now and the prompt owns them; the files are
      // scratch and must not accumulate under the user's temporary directory.
      await rm(outDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
