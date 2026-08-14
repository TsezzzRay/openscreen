import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CaptureArtifactStore } from "../../src/capture/artifact-store.js";
import type { CaptureArtifact } from "../../src/capture/artifact.js";

function artifact(): CaptureArtifact {
  const window = {
    processIdentifier: 100,
    bundleIdentifier: "com.example.Editor",
    applicationName: "Editor",
    windowIdentifier: 7,
    title: "Document",
  };
  const signal = {
    kind: "mouseClick" as const,
    occurredAt: "2026-08-11T00:00:00.000Z",
    window,
  };
  return {
    captureId: "capture-1",
    activityRevision: 1,
    completedActivityRevision: 1,
    contentEpoch: 1,
    completedContentEpoch: 1,
    signal,
    target: window,
    status: "complete",
    completedAtMilliseconds: 1_000,
    result: {
      capturedAt: "2026-08-11T00:00:00.100Z",
      validation: {
        preflightDurationMilliseconds: 2,
        attestationDurationMilliseconds: 1,
      },
      window,
      screenshot: {
        status: "complete",
        durationMilliseconds: 10,
        mimeType: "image/jpeg",
        dataBase64: Buffer.from("jpeg bytes").toString("base64"),
        width: 100,
        height: 80,
      },
      accessibility: {
        status: "complete",
        quality: "useful",
        durationMilliseconds: 5,
        contentRootFound: true,
        semanticNodeCount: 2,
        usefulTextCharacters: 12,
        snapshot: {
          nodeCount: 2,
          truncated: false,
          root: {
            role: "AXWindow",
            children: [{ role: "AXStaticText", value: "Visible body" }],
          },
        },
      },
    },
  };
}

test("persists one private structured artifact and JPEG without base64 duplication", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-artifact-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new CaptureArtifactStore(root);

  const persisted = await store.persist(artifact());
  const structured = JSON.parse(await readFile(persisted.structuredPath, "utf8"));

  assert.equal(structured.captureId, "capture-1");
  assert.equal(structured.result.accessibility.quality, "useful");
  assert.equal("dataBase64" in structured.result.screenshot, false);
  assert.equal(await readFile(persisted.screenshot!.path, "utf8"), "jpeg bytes");
  assert.equal((await stat(persisted.structuredPath)).mode & 0o777, 0o600);
  assert.equal((await stat(persisted.screenshot!.path)).mode & 0o777, 0o600);
});

test("persists a failed screenshot reason without creating a JPEG", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-artifact-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new CaptureArtifactStore(root);
  const failed = artifact();
  failed.captureId = "capture-failed";
  failed.status = "ax_only";
  failed.result.screenshot = {
    status: "failed",
    durationMilliseconds: 10,
    failureReason: "no_display",
  };

  const persisted = await store.persist(failed);
  const structured = JSON.parse(await readFile(persisted.structuredPath, "utf8"));

  assert.equal(structured.result.screenshot.status, "failed");
  assert.equal(structured.result.screenshot.failureReason, "no_display");
  assert.equal("screenshotFile" in structured, false);
  assert.equal(persisted.screenshot, undefined);
});
