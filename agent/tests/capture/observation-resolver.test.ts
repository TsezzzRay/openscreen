import assert from "node:assert/strict";
import test from "node:test";

import {
  ObservationResolver,
} from "../../src/capture/observation-resolver.js";
import type {
  CaptureArtifact,
} from "../../src/capture/artifact.js";
import type {
  NativeActivityKind,
} from "../../src/capture/native/protocol.js";
import type { ScreenObservation } from "../../src/capture/observation.js";
import type { CaptureDiagnosticEvent } from "../../src/capture/diagnostics.js";

function artifact(
  captureId: string,
  activityRevision: number,
  kind: NativeActivityKind = "mouseClick",
  visibleText = "Document",
): CaptureArtifact {
  const signal = {
    kind,
    occurredAt: "2026-08-07T00:00:00.000Z",
    window: {
      processIdentifier: 100,
      bundleIdentifier: "com.example.Editor",
      applicationName: "Editor",
      windowIdentifier: 7,
      title: "Document",
      frame: { x: 0, y: 0, width: 1_200, height: 800 },
    },
  };
  return {
    captureId,
    activityRevision,
    completedActivityRevision: activityRevision,
    contentEpoch: activityRevision,
    completedContentEpoch: activityRevision,
    signal,
    target: signal.window,
    status: "complete",
    completedAtMilliseconds: 1_000,
    result: {
      capturedAt: "2026-08-07T00:00:00.100Z",
      validation: {
        preflightDurationMilliseconds: 2,
        attestationDurationMilliseconds: 1,
      },
      window: signal.window,
      screenshot: {
        status: "complete",
        durationMilliseconds: 10,
        mimeType: "image/jpeg",
        dataBase64: "aW1hZ2U=",
        width: 100,
        height: 80,
      },
      accessibility: {
        status: "complete",
        durationMilliseconds: 5,
        snapshot: {
          nodeCount: 2,
          truncated: false,
          root: {
            role: "AXWindow",
            title: "Document",
            children: [{ role: "AXStaticText", value: visibleText }],
          },
        },
      },
    },
  };
}

test("persists one observation when activity and request share an artifact", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const persisted: ScreenObservation[] = [];
  const diagnostics: CaptureDiagnosticEvent[] = [];
  const resolver = new ObservationResolver({
    makeObservationId: () => "observation-1",
    persist: async (observation) => {
      persisted.push(observation);
      await gate;
    },
    diagnostics: { emit: (event) => diagnostics.push(event) },
  });
  const shared = artifact("capture-1", 1, "focusedWindowChanged");

  const first = resolver.resolve(shared);
  const second = resolver.resolve(shared);
  release();
  const [created, reused] = await Promise.all([first, second]);

  assert.equal(persisted.length, 1);
  assert.equal(created.decision, "created");
  assert.equal(reused.decision, "reused");
  assert.equal(created.observationId, "observation-1");
  assert.equal(reused.observationId, "observation-1");
  assert.deepEqual(
    diagnostics.map(({ event, result, captureId, observationId }) => ({
      event,
      result,
      captureId,
      observationId,
    })),
    [
      {
        event: "observation.resolved",
        result: "created",
        captureId: "capture-1",
        observationId: "observation-1",
      },
      {
        event: "observation.resolved",
        result: "reused",
        captureId: "capture-1",
        observationId: "observation-1",
      },
    ],
  );
});

test("references the observation already recorded for the same activity revision", async () => {
  const persisted: ScreenObservation[] = [];
  const resolver = new ObservationResolver({
    makeObservationId: () => "observation-1",
    persist: async (observation) => { persisted.push(observation); },
  });

  const first = await resolver.resolve(artifact(
    "capture-1",
    1,
    "focusedWindowChanged",
  ));
  const second = await resolver.resolve(artifact(
    "capture-2",
    1,
    "focusedWindowChanged",
    "Fresh screenshot, same activity",
  ));

  assert.equal(first.decision, "created");
  assert.equal(second.decision, "reused");
  assert.equal(second.observationId, first.observationId);
  assert.equal(persisted.length, 1);
});

test("references old ordinary content but creates a record for a real boundary", async () => {
  let sequence = 0;
  const persisted: ScreenObservation[] = [];
  const resolver = new ObservationResolver({
    makeObservationId: () => "observation-" + String(++sequence),
    persist: async (observation) => { persisted.push(observation); },
  });

  const original = await resolver.resolve(artifact("capture-1", 1));
  const unchanged = await resolver.resolve(artifact("capture-2", 2));
  const boundary = await resolver.resolve(artifact(
    "capture-3",
    3,
    "focusedWindowChanged",
  ));

  assert.equal(original.decision, "created");
  assert.equal(unchanged.decision, "reused");
  assert.equal(unchanged.observationId, original.observationId);
  assert.equal(boundary.decision, "created");
  assert.notEqual(boundary.observationId, original.observationId);
  assert.equal(persisted.length, 2);
  assert.equal(
    (resolver as unknown as { candidates: Map<string, unknown> }).candidates.size,
    0,
  );
});

test("uses the configured visual threshold when deciding whether to reuse an observation", async () => {
  let sequence = 0;
  const persisted: ScreenObservation[] = [];
  const diagnostics: CaptureDiagnosticEvent[] = [];
  const resolver = new ObservationResolver({
    makeObservationId: () => "observation-" + String(++sequence),
    persist: async (observation) => { persisted.push(observation); },
    visualChangeThreshold: 0.1,
    diagnostics: { emit: (event) => diagnostics.push(event) },
  });
  const original = artifact("capture-1", 1);
  original.result.visualSignature = [0, 0];
  const smallChange = artifact("capture-2", 2);
  smallChange.result.visualSignature = [20, 20];

  const created = await resolver.resolve(original);
  const reused = await resolver.resolve(smallChange);

  assert.equal(created.decision, "created");
  assert.equal(reused.decision, "reused");
  assert.equal(reused.observationId, created.observationId);
  assert.equal(persisted.length, 1);
  assert.equal(diagnostics.at(-1)?.semanticChanged, false);
  assert.equal(diagnostics.at(-1)?.visualChanged, false);
  assert.ok(Math.abs((diagnostics.at(-1)?.visualDistance ?? 0) - 20 / 255) < 0.000_001);
});

test("retries the same observation identity after persistence fails", async () => {
  let attempts = 0;
  const diagnostics: CaptureDiagnosticEvent[] = [];
  const resolver = new ObservationResolver({
    makeObservationId: () => "observation-stable",
    persist: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("storage unavailable");
    },
    diagnostics: { emit: (event) => diagnostics.push(event) },
  });
  const capture = artifact("capture-1", 1);

  await assert.rejects(resolver.resolve(capture), /storage unavailable/);
  const resolved = await resolver.resolve(capture);

  assert.equal(attempts, 2);
  assert.equal(resolved.decision, "created");
  assert.equal(resolved.observationId, "observation-stable");
  assert.deepEqual(
    diagnostics.map(({ result, observationId, reason }) => ({
      result,
      observationId,
      reason,
    })),
    [
      {
        result: "unavailable",
        observationId: "observation-stable",
        reason: "persistence_failed",
      },
      {
        result: "created",
        observationId: "observation-stable",
        reason: undefined,
      },
    ],
  );
});
