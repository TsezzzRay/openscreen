import assert from "node:assert/strict";
import test from "node:test";

import {
  CaptureCoordinator,
  CaptureInvalidatedError,
} from "../../src/capture/coordinator.js";
import type { CaptureArtifact } from "../../src/capture/artifact.js";
import type {
  NativeActivitySignal,
  NativeCaptureResult,
} from "../../src/capture/native/protocol.js";
import type {
  CaptureDiagnosticEvent,
} from "../../src/capture/diagnostics.js";

function signal(
  occurredAt = "2026-08-07T00:00:00.000Z",
  windowIdentifier: number | undefined = 7,
  processIdentifier = 100,
  kind: NativeActivitySignal["kind"] = "focusedWindowChanged",
): NativeActivitySignal {
  return {
    kind,
    occurredAt,
    window: {
      processIdentifier,
      bundleIdentifier: "com.example.Editor",
      applicationName: "Editor",
      windowIdentifier,
      title: "Document",
      frame: { x: 0, y: 0, width: 1_200, height: 800 },
    },
  };
}

function result(
  source: NativeActivitySignal,
  accessibilityStatus: "complete" | "failed" = "complete",
  accessibilityQuality: "useful" | "shell_only" = "useful",
): NativeCaptureResult {
  return {
    startedAt: "2026-08-07T00:00:00.010Z",
    capturedAt: "2026-08-07T00:00:00.100Z",
    validation: {
      preflightDurationMilliseconds: 2,
      attestationDurationMilliseconds: 1,
    },
    window: source.window,
    ...(source.window.windowIdentifier === undefined
      ? {}
      : {
        windowGroup: {
          processIdentifier: source.window.processIdentifier,
          rootWindowIdentifier: source.window.windowIdentifier,
          memberWindowIdentifiers: [3],
          frame: source.window.frame ?? { x: 0, y: 0, width: 1_200, height: 800 },
        },
      }),
    screenshot: {
      status: "complete",
      durationMilliseconds: 10,
      completedAt: "2026-08-07T00:00:00.040Z",
      mimeType: "image/jpeg",
      dataBase64: "aW1hZ2U=",
      width: 100,
      height: 80,
    },
    accessibility: {
      status: accessibilityStatus,
      quality: accessibilityStatus === "complete"
        ? accessibilityQuality
        : "unavailable",
      durationMilliseconds: 5,
      completedAt: "2026-08-07T00:00:00.080Z",
      contentRootFound: accessibilityQuality === "useful",
      semanticNodeCount: accessibilityQuality === "useful" ? 1 : 0,
      usefulTextCharacters: accessibilityQuality === "useful" ? 8 : 0,
      activation: {
        status: "enabled",
        attempts: [
          { method: "enhanced_ui", status: "unsupported" },
          { method: "manual_accessibility", status: "enabled" },
        ],
        waitMilliseconds: 12,
        nodeCountBefore: 1,
        nodeCountAfter: 8,
      },
      ...(accessibilityStatus === "complete"
        ? {
            snapshot: {
              nodeCount: 1,
              truncated: false,
              root: { role: "AXWindow", title: "Document" },
            },
          }
        : {}),
    },
  };
}

test("joins an in-flight physical capture for the same frozen target and revision", async () => {
  let release!: (value: NativeCaptureResult) => void;
  const physical = new Promise<NativeCaptureResult>((resolve) => { release = resolve; });
  let captures = 0;
  const diagnostics: CaptureDiagnosticEvent[] = [];
  const coordinator = new CaptureCoordinator({
    reuseWindowMilliseconds: 250,
    capture: async () => {
      captures += 1;
      return physical;
    },
    makeCaptureId: () => "capture-1",
    diagnostics: { emit: (event) => diagnostics.push(event) },
  });
  const activity = signal();
  const frozen = coordinator.observe(activity);

  const first = coordinator.capture("activity", frozen);
  const second = coordinator.capture("request", frozen);
  release(result(activity));

  const [newCapture, joinedCapture] = await Promise.all([first, second]);
  assert.equal(captures, 1);
  assert.equal(newCapture.decision, "new");
  assert.equal(joinedCapture.decision, "join");
  assert.equal(newCapture.artifact.captureId, "capture-1");
  assert.strictEqual(newCapture.artifact, joinedCapture.artifact);
  assert.equal(
    diagnostics.filter(({ event }) => event === "capture.started").length,
    1,
  );
  assert.deepEqual(
    diagnostics
      .filter(({ event }) => event === "capture.decision")
      .map(({ decision, captureId }) => ({ decision, captureId })),
    [
      { decision: "new", captureId: "capture-1" },
      { decision: "join", captureId: "capture-1" },
    ],
  );
  const completed = diagnostics.find(({ event }) => event === "capture.completed");
  assert.equal(completed?.preflightMs, 2);
  assert.equal(completed?.screenshotMs, 10);
  assert.equal(completed?.accessibilityMs, 5);
  assert.equal(completed?.attestationMs, 1);
  assert.equal(completed?.status, "complete");
  assert.equal(completed?.captureStartedAt, "2026-08-07T00:00:00.010Z");
  assert.equal(
    completed?.screenshotCompletedAt,
    "2026-08-07T00:00:00.040Z",
  );
  assert.equal(
    completed?.accessibilityCompletedAt,
    "2026-08-07T00:00:00.080Z",
  );
  assert.equal(completed?.captureCompletedAt, "2026-08-07T00:00:00.100Z");
  assert.equal(completed?.servedConsumerCount, 2);
  assert.equal(completed?.activityKind, "focusedWindowChanged");
  assert.equal(completed?.accessibility?.truncated, false);
  assert.equal(completed?.accessibility?.quality, "useful");
  assert.equal(completed?.accessibility?.contentRootFound, true);
  assert.equal(completed?.accessibility?.semanticNodeCount, 1);
  assert.equal(completed?.accessibility?.usefulTextCharacters, 8);
  assert.deepEqual(completed?.accessibility?.activationAttempts, [
    { method: "enhanced_ui", status: "unsupported" },
    { method: "manual_accessibility", status: "enabled" },
  ]);
  assert.equal(completed?.rootWindowIdentifier, 7);
  assert.equal(completed?.memberWindowCount, 1);
});

test("reuses a completed artifact for 250ms when no later activity exists", async () => {
  let now = 1_000;
  let captures = 0;
  const activity = signal();
  const coordinator = new CaptureCoordinator({
    reuseWindowMilliseconds: 250,
    now: () => now,
    capture: async () => {
      captures += 1;
      return result(activity);
    },
    makeCaptureId: () => `capture-${captures}`,
  });
  const frozen = coordinator.observe(activity);

  const first = await coordinator.capture("activity", frozen);
  now += 250;
  const reused = await coordinator.capture("request", coordinator.freezeLatest()!);

  assert.equal(captures, 1);
  assert.equal(reused.decision, "reuse");
  assert.strictEqual(reused.artifact, first.artifact);

  now += 1;
  const next = await coordinator.capture("request", coordinator.freezeLatest()!);
  assert.equal(captures, 2);
  assert.equal(next.decision, "new");
  assert.notEqual(next.artifact.captureId, first.artifact.captureId);
});

test("accepts a capture when same-window content changes and records both epochs", async () => {
  let release!: (value: NativeCaptureResult) => void;
  const activity = signal();
  const diagnostics: CaptureDiagnosticEvent[] = [];
  const coordinator = new CaptureCoordinator({
    reuseWindowMilliseconds: 250,
    capture: () => new Promise<NativeCaptureResult>((resolve) => { release = resolve; }),
    diagnostics: { emit: (event) => diagnostics.push(event) },
  });
  const frozen = coordinator.observe(activity);
  const pending = coordinator.capture("request", frozen);
  await Promise.resolve();

  const later = coordinator.observe(signal(
    "2026-08-07T00:00:00.050Z",
    7,
    100,
    "keyActivity",
  ));
  release(result(activity));

  const resolution = await pending;
  assert.equal(resolution.artifact.activityRevision, frozen.activityRevision);
  assert.equal(resolution.artifact.contentEpoch, 0);
  assert.equal(resolution.artifact.completedActivityRevision, later.activityRevision);
  assert.equal(resolution.artifact.completedContentEpoch, 1);
  const completed = diagnostics.find(({ event }) => event === "capture.completed");
  assert.equal(completed?.activityRevisionEnd, later.activityRevision);
  assert.equal(completed?.activityChangedDuringCapture, true);
  assert.equal(
    diagnostics.filter(({ event }) => event === "capture.attestation_failed").length,
    0,
  );
});

test("invalidates a capture when the confirmed target changes before it completes", async () => {
  let release!: (value: NativeCaptureResult) => void;
  const activity = signal();
  const diagnostics: CaptureDiagnosticEvent[] = [];
  const coordinator = new CaptureCoordinator({
    reuseWindowMilliseconds: 250,
    capture: () => new Promise<NativeCaptureResult>((resolve) => { release = resolve; }),
    diagnostics: { emit: (event) => diagnostics.push(event) },
  });
  const frozen = coordinator.observe(activity);
  const pending = coordinator.capture("request", frozen);
  await Promise.resolve();

  coordinator.observe(signal("2026-08-07T00:00:00.050Z", 8));
  release(result(activity));

  await assert.rejects(pending, CaptureInvalidatedError);
  assert.ok(diagnostics.some((event) =>
    event.event === "capture.attestation_failed" &&
    event.reason === "target_changed"
  ));
});

test("does not report a physical start when a queued target becomes stale", async () => {
  let release!: (value: NativeCaptureResult) => void;
  const firstSignal = signal();
  const physical = new Promise<NativeCaptureResult>((resolve) => { release = resolve; });
  const diagnostics: CaptureDiagnosticEvent[] = [];
  let captureNumber = 0;
  const coordinator = new CaptureCoordinator({
    reuseWindowMilliseconds: 250,
    capture: async () => physical,
    makeCaptureId: () => `capture-${++captureNumber}`,
    diagnostics: { emit: (event) => diagnostics.push(event) },
  });
  const first = coordinator.capture(
    "activity",
    coordinator.observe(firstSignal),
    "activity-1",
  );
  const second = coordinator.capture(
    "request",
    coordinator.observe(signal("2026-08-07T00:00:00.050Z", 8)),
    "request-1",
  );
  coordinator.observe(signal("2026-08-07T00:00:00.100Z", 9));
  release(result(firstSignal));

  await assert.rejects(first, CaptureInvalidatedError);
  await assert.rejects(second, CaptureInvalidatedError);
  assert.ok(diagnostics.some((event) =>
    event.event === "capture.skipped" &&
    event.captureId === "capture-2" &&
    event.reason === "target_changed"
  ));
  assert.equal(diagnostics.some((event) =>
    event.event === "capture.started" && event.captureId === "capture-2"
  ), false);
});

test("joins an in-flight capture across same-window activity revisions", async () => {
  let release!: (value: NativeCaptureResult) => void;
  const physical = new Promise<NativeCaptureResult>((resolve) => { release = resolve; });
  const activity = signal();
  let captures = 0;
  const coordinator = new CaptureCoordinator({
    reuseWindowMilliseconds: 250,
    capture: () => {
      captures += 1;
      return physical;
    },
  });
  const firstFrozen = coordinator.observe(activity);
  const first = coordinator.capture("activity", firstFrozen);
  const laterFrozen = coordinator.observe(signal("2026-08-07T00:00:00.050Z"));
  const joined = coordinator.capture("request", laterFrozen);
  release(result(activity));

  const [firstResolution, joinedResolution] = await Promise.all([first, joined]);
  assert.equal(captures, 1);
  assert.equal(joinedResolution.decision, "join");
  assert.strictEqual(joinedResolution.artifact, firstResolution.artifact);
});

test("reuses a fresh completed capture across same-window activity revisions", async () => {
  let now = 1_000;
  let captures = 0;
  const activity = signal();
  const coordinator = new CaptureCoordinator({
    reuseWindowMilliseconds: 250,
    now: () => now,
    capture: async () => {
      captures += 1;
      return result(activity);
    },
  });
  const first = await coordinator.capture("activity", coordinator.observe(activity));
  now += 100;
  const laterFrozen = coordinator.observe(signal("2026-08-07T00:00:00.050Z"));
  const reused = await coordinator.capture("request", laterFrozen);

  assert.equal(captures, 1);
  assert.equal(reused.decision, "reuse");
  assert.strictEqual(reused.artifact, first.artifact);
});

test("does not join an in-flight capture after same-window content changes", async () => {
  let releaseFirst!: (value: NativeCaptureResult) => void;
  const activity = signal();
  let captures = 0;
  const coordinator = new CaptureCoordinator({
    reuseWindowMilliseconds: 250,
    capture: async () => {
      captures += 1;
      if (captures === 1) {
        return new Promise<NativeCaptureResult>((resolve) => {
          releaseFirst = resolve;
        });
      }
      return result(activity);
    },
  });
  const first = coordinator.capture("activity", coordinator.observe(activity));
  const later = coordinator.observe(signal(
    "2026-08-07T00:00:00.050Z",
    7,
    100,
    "accessibilityChanged",
  ));
  const second = coordinator.capture("request", later);
  await Promise.resolve();
  releaseFirst(result(activity));

  const [firstResolution, secondResolution] = await Promise.all([first, second]);
  assert.equal(captures, 2);
  assert.equal(firstResolution.decision, "new");
  assert.equal(secondResolution.decision, "new");
  assert.notEqual(secondResolution.artifact.captureId, firstResolution.artifact.captureId);
  assert.equal(secondResolution.intentRevision, later.activityRevision);
  assert.equal(secondResolution.intentContentEpoch, later.contentEpoch);
});

test("does not reuse a completed capture after same-window content changes", async () => {
  let now = 1_000;
  let captures = 0;
  const activity = signal();
  const coordinator = new CaptureCoordinator({
    reuseWindowMilliseconds: 250,
    now: () => now,
    capture: async () => {
      captures += 1;
      return result(activity);
    },
  });
  await coordinator.capture("activity", coordinator.observe(activity));
  now += 100;
  const later = coordinator.observe(signal(
    "2026-08-07T00:00:00.050Z",
    7,
    100,
    "mouseClick",
  ));
  const next = await coordinator.capture("request", later);

  assert.equal(captures, 2);
  assert.equal(next.decision, "new");
});

test("rejects a helper result for another window", async () => {
  const activity = signal();
  const coordinator = new CaptureCoordinator({
    reuseWindowMilliseconds: 250,
    capture: async () => result(signal(activity.occurredAt, 8)),
  });
  const frozen = coordinator.observe(activity);

  await assert.rejects(
    coordinator.capture("request", frozen),
    /Capture target identity mismatch/,
  );
});

test("keeps a valid screenshot when accessibility capture fails", async () => {
  const activity = signal();
  const coordinator = new CaptureCoordinator({
    reuseWindowMilliseconds: 250,
    capture: async () => result(activity, "failed"),
  });
  const frozen = coordinator.observe(activity);

  const resolution = await coordinator.capture("request", frozen);

  assert.equal(resolution.artifact.status, "screenshot_only");
  assert.equal(resolution.artifact.result.screenshot.status, "complete");
  assert.equal(resolution.artifact.result.accessibility.status, "failed");
});

test("treats a shell-only AX snapshot as screenshot-only", async () => {
  const activity = signal();
  const coordinator = new CaptureCoordinator({
    reuseWindowMilliseconds: 250,
    capture: async () => result(activity, "complete", "shell_only"),
  });

  const resolution = await coordinator.capture(
    "request",
    coordinator.observe(activity),
  );

  assert.equal(resolution.artifact.status, "screenshot_only");
  assert.equal(resolution.artifact.result.accessibility.quality, "shell_only");
});

test("preserves safe helper failure codes in diagnostics", async () => {
  const activity = signal();
  const diagnostics: CaptureDiagnosticEvent[] = [];
  const coordinator = new CaptureCoordinator({
    reuseWindowMilliseconds: 250,
    capture: async () => {
      throw Object.assign(new Error("target unavailable"), {
        code: "target_unavailable",
      });
    },
    diagnostics: { emit: (event) => diagnostics.push(event) },
  });
  const frozen = coordinator.observe(activity);

  await assert.rejects(coordinator.capture("request", frozen));

  assert.equal(
    diagnostics.filter(({ event }) => event === "capture.completed").at(-1)?.reason,
    "target_unavailable",
  );
});

test("keeps a completed request artifact when artifact persistence fails", async () => {
  const activity = signal();
  const diagnostics: CaptureDiagnosticEvent[] = [];
  const coordinator = new CaptureCoordinator({
    reuseWindowMilliseconds: 2_000,
    capture: async () => result(activity),
    persistArtifact: async () => { throw new Error("disk unavailable"); },
    diagnostics: { emit: (event) => diagnostics.push(event) },
  });

  const resolution = await coordinator.capture(
    "request",
    coordinator.observe(activity),
  );

  assert.equal(resolution.artifact.status, "complete");
  assert.equal(resolution.artifact.persistence, undefined);
  assert.ok(diagnostics.some((event) =>
    event.event === "capture.persistence_failed" &&
    event.captureId === resolution.artifact.captureId
  ));
});

test("records successful artifact persistence latency separately", async () => {
  const activity = signal();
  const diagnostics: CaptureDiagnosticEvent[] = [];
  let now = 1_000;
  const coordinator = new CaptureCoordinator({
    reuseWindowMilliseconds: 2_000,
    now: () => now,
    capture: async () => result(activity),
    persistArtifact: async () => {
      now += 7;
      return { structuredPath: "/private/capture.json" };
    },
    diagnostics: { emit: (event) => diagnostics.push(event) },
  });

  const resolution = await coordinator.capture(
    "request",
    coordinator.observe(activity),
  );

  assert.equal(
    resolution.artifact.persistence?.structuredPath,
    "/private/capture.json",
  );
  assert.equal(
    diagnostics.find(({ event }) => event === "capture.completed")
      ?.persistenceMs,
    7,
  );
});

test("invalidates the latest target after native capture reports it unavailable", async () => {
  const activity = signal();
  const diagnostics: CaptureDiagnosticEvent[] = [];
  const coordinator = new CaptureCoordinator({
    reuseWindowMilliseconds: 250,
    capture: async () => {
      throw Object.assign(new Error("target unavailable"), {
        code: "target_unavailable",
      });
    },
    diagnostics: { emit: (event) => diagnostics.push(event) },
  });
  const frozen = coordinator.observe(activity);

  await assert.rejects(coordinator.capture("activity", frozen));

  assert.equal(coordinator.freezeLatest(), undefined);
  assert.ok(diagnostics.some((event) =>
    (event.event as string) === "target_invalidated" &&
    event.reason === "target_unavailable"
  ));
});

test("cancels only the request consumer while shared physical capture continues", async () => {
  let release!: (value: NativeCaptureResult) => void;
  const activity = signal();
  const diagnostics: CaptureDiagnosticEvent[] = [];
  const controller = new AbortController();
  let now = 1_000;
  const coordinator = new CaptureCoordinator({
    reuseWindowMilliseconds: 250,
    now: () => now,
    capture: () => new Promise<NativeCaptureResult>((resolve) => {
      release = resolve;
    }),
    makeCaptureId: () => "capture-1",
    diagnostics: { emit: (event) => diagnostics.push(event) },
  });
  const frozen = coordinator.observe(activity);

  const request = coordinator.capture(
    "request",
    frozen,
    "request-1",
    controller.signal,
  );
  controller.abort();
  await assert.rejects(request, { name: "AbortError" });

  release(result(activity));
  await new Promise((resolve) => setImmediate(resolve));
  now += 1;
  const reused = await coordinator.capture("request", frozen, "request-2");

  assert.equal(reused.decision, "reuse");
  assert.ok(diagnostics.some((event) =>
    event.event === "capture.consumer_cancelled" &&
    event.requestId === "request-1" &&
    event.captureId === "capture-1"
  ));
});

test("rejects an abort that lands between the initial check and listener registration", async () => {
  let release!: (value: NativeCaptureResult) => void;
  let captures = 0;
  const activity = signal();
  const coordinator = new CaptureCoordinator({
    reuseWindowMilliseconds: 250,
    capture: () => {
      captures += 1;
      return new Promise<NativeCaptureResult>((resolve) => {
        release = resolve;
      });
    },
  });
  const frozen = coordinator.observe(activity);
  const physical = coordinator.capture("activity", frozen, "activity-1");
  const controller = new AbortController();
  let initialCheck = true;
  Object.defineProperty(controller.signal, "aborted", {
    configurable: true,
    get() {
      if (initialCheck) {
        initialCheck = false;
        controller.abort();
        return false;
      }
      return true;
    },
  });

  const request = coordinator.capture(
    "request",
    frozen,
    "request-race",
    controller.signal,
  );
  const immediateOutcome = await Promise.race([
    request.then(
      () => "resolved",
      (error: Error) => error.name,
    ),
    new Promise<string>((resolve) => setImmediate(() => resolve("pending"))),
  ]);
  await new Promise((resolve) => setImmediate(resolve));
  release(result(activity));
  await physical;

  assert.equal(immediateOutcome, "AbortError");
  assert.equal(captures, 1);
  const reused = await coordinator.capture("request", frozen, "request-after");
  assert.equal(reused.decision, "reuse");
});

test("freezing returns the latest confirmed external target and revision", () => {
  const coordinator = new CaptureCoordinator({
    reuseWindowMilliseconds: 250,
    capture: async () => { throw new Error("not reached"); },
  });
  assert.equal(coordinator.freezeLatest(), undefined);

  const first = coordinator.observe(signal());
  const second = coordinator.observe(signal("2026-08-07T00:00:01.000Z", 9));

  assert.equal(first.activityRevision, 1);
  assert.equal(second.activityRevision, 2);
  assert.equal(first.contentEpoch, 0);
  assert.equal(second.contentEpoch, 0);
  assert.strictEqual(coordinator.frozenFor(second.signal), second);
  assert.deepEqual(coordinator.freezeLatest(), second);
});

test("records visual activity without advancing content epoch when it is not meaningful", () => {
  const coordinator = new CaptureCoordinator({
    reuseWindowMilliseconds: 2_000,
    capture: async () => { throw new Error("not reached"); },
  });
  const first = coordinator.observe(signal());
  const visual = signal(
    "2026-08-07T00:00:00.500Z",
    7,
    100,
    "visualChanged",
  );
  visual.visualSignature = [1, 1, 1, 1];

  const ignored = coordinator.observe(visual, { contentChanged: false });
  const meaningful = coordinator.observe(visual, { contentChanged: true });

  assert.equal(first.contentEpoch, 0);
  assert.equal(ignored.activityRevision, 2);
  assert.equal(ignored.contentEpoch, 0);
  assert.equal(meaningful.activityRevision, 3);
  assert.equal(meaningful.contentEpoch, 1);
});

test("a signal without a qualified window invalidates the latest confirmed target", () => {
  const coordinator = new CaptureCoordinator({
    reuseWindowMilliseconds: 250,
    capture: async () => { throw new Error("not reached"); },
  });
  const confirmed = coordinator.observe(signal());
  const incompleteSignal = signal("2026-08-07T00:00:01.000Z");
  delete incompleteSignal.window.windowIdentifier;
  const incomplete = coordinator.observe(incompleteSignal);

  assert.equal(incomplete.activityRevision, 2);
  assert.strictEqual(coordinator.frozenFor(incomplete.signal), incomplete);
  assert.equal(coordinator.freezeLatest(), undefined);
});

test("a different-process signal without a window ID makes the target unavailable", () => {
  const coordinator = new CaptureCoordinator({
    reuseWindowMilliseconds: 250,
    capture: async () => { throw new Error("not reached"); },
  });
  coordinator.observe(signal());
  const incompleteSignal = signal("2026-08-07T00:00:01.000Z", 7, 200);
  delete incompleteSignal.window.windowIdentifier;
  coordinator.observe(incompleteSignal);

  assert.equal(coordinator.freezeLatest(), undefined);
});

test("rejects a signal without an exact window identifier before native capture", async () => {
  let captures = 0;
  const diagnostics: CaptureDiagnosticEvent[] = [];
  const coordinator = new CaptureCoordinator({
    reuseWindowMilliseconds: 250,
    capture: async () => {
      captures += 1;
      throw new Error("not reached");
    },
    diagnostics: { emit: (event) => diagnostics.push(event) },
  });
  const activity = signal();
  delete activity.window.windowIdentifier;
  const frozen = coordinator.observe(activity);

  await assert.rejects(
    coordinator.capture("request", frozen, "request-1"),
    /exact window identifier/,
  );

  assert.equal(captures, 0);
  assert.ok(diagnostics.some((event) =>
    event.event === "capture.decision" &&
    event.decision === "unavailable" &&
    event.reason === "missing_window_identifier"
  ));
});

const _artifactTypeCheck: CaptureArtifact | undefined = undefined;
void _artifactTypeCheck;
