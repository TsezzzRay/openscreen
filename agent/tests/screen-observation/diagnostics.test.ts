import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CaptureDiagnostics,
  screenshotDiagnosticFields,
} from "../../src/extensions/screen-observation/diagnostics.js";

test("projects complete JPEG metadata for capture diagnostics", () => {
  assert.deepEqual(screenshotDiagnosticFields({
    status: "complete",
    durationMilliseconds: 10,
    mimeType: "image/jpeg",
    dataBase64: Buffer.from("image").toString("base64"),
    width: 100,
    height: 80,
  }), {
    screenshot: {
      status: "complete",
      mimeType: "image/jpeg",
      width: 100,
      height: 80,
      bytes: 5,
    },
  });
});

test("projects failed screenshot status and reason without screen content", () => {
  assert.deepEqual(screenshotDiagnosticFields({
    status: "failed",
    durationMilliseconds: 10,
    failureReason: "no_display",
  }), {
    screenshot: {
      status: "failed",
      failureReason: "no_display",
    },
  });
});

test("persists private daily JSONL without screen or prompt content", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openscreen-capture-diagnostics-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const diagnostics = new CaptureDiagnostics({
    directory,
    retentionMilliseconds: 7 * 24 * 60 * 60 * 1_000,
    now: () => new Date("2026-08-07T12:34:56.000Z"),
  });

  diagnostics.emit({
    event: "capture.decision",
    intentId: "request-1",
    captureId: "capture-1",
    consumer: "request",
    activityRevision: 4,
    intentRevision: 6,
    artifactRevision: 4,
    completedRevision: 5,
    contentEpoch: 3,
    intentContentEpoch: 3,
    artifactContentEpoch: 2,
    completedContentEpoch: 3,
    targetKey: "target-token",
    decision: "reuse",
    reason: "fresh_completed_capture",
    cachedAgeMs: 125,
    windowTitle: "secret title",
    url: "https://secret.example",
    prompt: "secret prompt",
    visibleText: "secret screen text",
  } as any);
  await diagnostics.flush();

  const path = join(directory, "capture-events-2026-08-07.jsonl");
  const value = JSON.parse((await readFile(path, "utf8")).trim());
  assert.deepEqual(value, {
    timestamp: "2026-08-07T12:34:56.000Z",
    event: "capture.decision",
    intentId: "request-1",
    captureId: "capture-1",
    consumer: "request",
    activityRevision: 4,
    intentRevision: 6,
    artifactRevision: 4,
    completedRevision: 5,
    contentEpoch: 3,
    intentContentEpoch: 3,
    artifactContentEpoch: 2,
    completedContentEpoch: 3,
    targetKey: "target-token",
    decision: "reuse",
    reason: "fresh_completed_capture",
    cachedAgeMs: 125,
  });
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test("rotates by UTC day and removes expired diagnostic files", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openscreen-capture-diagnostics-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const expired = join(directory, "capture-events-2026-07-01.jsonl");
  await writeFile(expired, "{}\n");
  const old = new Date("2026-07-01T00:00:00.000Z");
  await utimes(expired, old, old);
  const diagnostics = new CaptureDiagnostics({
    directory,
    retentionMilliseconds: 7 * 24 * 60 * 60 * 1_000,
    now: () => new Date("2026-08-08T00:00:00.000Z"),
  });

  diagnostics.emit({
    event: "capture.intent_received",
    intentId: "request-1",
    consumer: "request",
    activityRevision: 4,
    targetKey: "target-token",
  });
  await diagnostics.flush();

  assert.deepEqual(
    (await readdir(directory)).sort(),
    ["capture-events-2026-08-08.jsonl"],
  );
});

test("diagnostic write failures never reject capture callers", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-capture-diagnostics-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const notDirectory = join(root, "file");
  await writeFile(notDirectory, "occupied");
  const diagnostics = new CaptureDiagnostics({
    directory: notDirectory,
    retentionMilliseconds: 1_000,
  });

  diagnostics.emit({
    event: "capture.intent_received",
    intentId: "request-1",
    consumer: "request",
    activityRevision: 4,
    targetKey: "target-token",
  });

  await diagnostics.flush();
});

test("records the attached context modality without persisting content", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openscreen-capture-diagnostics-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const diagnostics = new CaptureDiagnostics({
    directory,
    retentionMilliseconds: 1_000,
    now: () => new Date("2026-08-07T12:34:56.000Z"),
  });

  diagnostics.emit({
    event: "chat.context_attached",
    requestId: "request-1",
    captureId: "capture-1",
    observationId: "observation-1",
    contextMode: "both",
    accessibility: {
      status: "complete",
      included: false,
      omittedReason: "no_useful_content",
      projectedNodeCount: 0,
      projectedCharacters: 512,
      candidateNodeCount: 2,
      usefulTextCharacters: 0,
      uniqueTextBlocks: 0,
    },
  });
  await diagnostics.flush();

  const value = JSON.parse((await readFile(
    join(directory, "capture-events-2026-08-07.jsonl"),
    "utf8",
  )).trim());
  assert.equal(value.contextMode, "both");
  assert.equal(value.accessibility.projectedCharacters, 512);
  assert.equal(value.accessibility.included, false);
  assert.equal(value.accessibility.omittedReason, "no_useful_content");
  assert.equal(value.accessibility.projectedNodeCount, 0);
  assert.equal(value.accessibility.candidateNodeCount, 2);
  assert.equal(value.accessibility.usefulTextCharacters, 0);
  assert.equal(value.accessibility.uniqueTextBlocks, 0);
});

test("persists window-group coverage without screen content", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openscreen-capture-diagnostics-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const diagnostics = new CaptureDiagnostics({
    directory,
    retentionMilliseconds: 1_000,
    now: () => new Date("2026-08-07T12:34:56.000Z"),
  });

  diagnostics.emit({
    event: "capture.completed",
    captureId: "capture-1",
    servedConsumerCount: 2,
    rootWindowIdentifier: 7,
    memberWindowCount: 1,
    accessibility: {
      status: "partial",
      quality: "useful",
      contentRootFound: true,
      semanticNodeCount: 3,
      usefulTextCharacters: 24,
      activationAttempts: [
        { method: "enhanced_ui", status: "unsupported" },
        { method: "manual_accessibility", status: "enabled" },
      ],
      capturedWindowCount: 1,
      missingWindowCount: 1,
    },
  });
  await diagnostics.flush();

  const value = JSON.parse((await readFile(
    join(directory, "capture-events-2026-08-07.jsonl"),
    "utf8",
  )).trim());
  assert.equal(value.servedConsumerCount, 2);
  assert.equal(value.rootWindowIdentifier, 7);
  assert.equal(value.memberWindowCount, 1);
  assert.equal(value.accessibility.quality, "useful");
  assert.equal(value.accessibility.contentRootFound, true);
  assert.equal(value.accessibility.semanticNodeCount, 3);
  assert.equal(value.accessibility.usefulTextCharacters, 24);
  assert.deepEqual(value.accessibility.activationAttempts, [
    { method: "enhanced_ui", status: "unsupported" },
    { method: "manual_accessibility", status: "enabled" },
  ]);
  assert.equal(value.accessibility.capturedWindowCount, 1);
  assert.equal(value.accessibility.missingWindowCount, 1);
});

test("persists visual recovery target and backoff without screen content", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openscreen-capture-diagnostics-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const diagnostics = new CaptureDiagnostics({
    directory,
    retentionMilliseconds: 1_000,
    now: () => new Date("2026-08-07T12:34:56.000Z"),
  });

  diagnostics.emit({
    event: "visual.restarting",
    generation: 4,
    rootWindowIdentifier: 7,
    restartDelayMs: 500,
  });
  await diagnostics.flush();

  const value = JSON.parse((await readFile(
    join(directory, "capture-events-2026-08-07.jsonl"),
    "utf8",
  )).trim());
  assert.equal(value.event, "visual.restarting");
  assert.equal(value.generation, 4);
  assert.equal(value.rootWindowIdentifier, 7);
  assert.equal(value.restartDelayMs, 500);
});
