import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

import type { CaptureArtifact } from "./coordinator.js";

export type PersistedCaptureScreenshot = {
  path: string;
  mimeType: "image/jpeg";
  width: number;
  height: number;
  sha256: string;
  bytes: number;
};

export type CaptureArtifactPersistence = {
  structuredPath: string;
  screenshot?: PersistedCaptureScreenshot;
};

export class CaptureArtifactStore {
  constructor(private readonly dataRoot: string) {}

  async persist(artifact: CaptureArtifact): Promise<CaptureArtifactPersistence> {
    validateCaptureId(artifact.captureId);
    const artifactsDirectory = join(this.dataRoot, "capture-artifacts");
    const screenshotsDirectory = join(this.dataRoot, "screen-captures");
    await privateDirectory(artifactsDirectory);

    const screenshot = artifact.result.screenshot;
    let persistedScreenshot: PersistedCaptureScreenshot | undefined;
    if (
      screenshot.status === "complete" &&
      screenshot.mimeType === "image/jpeg" &&
      screenshot.dataBase64 !== undefined &&
      screenshot.width !== undefined &&
      screenshot.height !== undefined
    ) {
      await privateDirectory(screenshotsDirectory);
      const data = Buffer.from(screenshot.dataBase64, "base64");
      const path = join(screenshotsDirectory, artifact.captureId + ".jpg");
      await atomicWrite(path, data);
      persistedScreenshot = {
        path,
        mimeType: "image/jpeg",
        width: screenshot.width,
        height: screenshot.height,
        sha256: createHash("sha256").update(data).digest("hex"),
        bytes: data.byteLength,
      };
    }

    const { dataBase64: _, ...screenshotMetadata } = screenshot;
    const structuredPath = join(artifactsDirectory, artifact.captureId + ".json");
    const structured = {
      schemaVersion: 1,
      captureId: artifact.captureId,
      activityRevision: artifact.activityRevision,
      completedActivityRevision: artifact.completedActivityRevision,
      contentEpoch: artifact.contentEpoch,
      completedContentEpoch: artifact.completedContentEpoch,
      signal: artifact.signal,
      target: artifact.target,
      status: artifact.status,
      completedAtMilliseconds: artifact.completedAtMilliseconds,
      result: {
        ...artifact.result,
        screenshot: screenshotMetadata,
      },
      ...(persistedScreenshot === undefined
        ? {}
        : {
          screenshotFile: {
            path: relative(this.dataRoot, persistedScreenshot.path),
            sha256: persistedScreenshot.sha256,
            bytes: persistedScreenshot.bytes,
          },
        }),
    };
    await atomicWrite(structuredPath, JSON.stringify(structured));
    return {
      structuredPath,
      ...(persistedScreenshot === undefined
        ? {}
        : { screenshot: persistedScreenshot }),
    };
  }
}

async function privateDirectory(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

async function atomicWrite(path: string, contents: string | Buffer) {
  const temporaryPath = path + "." + randomUUID() + ".tmp";
  await writeFile(temporaryPath, contents, { mode: 0o600 });
  await rename(temporaryPath, path);
  await chmod(path, 0o600);
}

function validateCaptureId(captureId: string) {
  if (!/^[A-Za-z0-9-]+$/.test(captureId)) {
    throw new Error("Invalid capture identifier");
  }
}
