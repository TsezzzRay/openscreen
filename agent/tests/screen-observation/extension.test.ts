import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ScreenObservationConfig } from "../../src/config.js";
import { ScreenObservationExtension } from "../../src/extensions/screen-observation/extension.js";
import type { ScreenObservation } from "../../src/extensions/screen-observation/types.js";
import type { CaptureDiagnosticEvent } from "../../src/extensions/screen-observation/diagnostics.js";
import type { NativeActivitySignal } from "../../src/extensions/screen-observation/protocol.js";

const config = {
  enabled: true,
  scheduling: {
    tickIntervalMilliseconds: 5,
    ordinaryCaptureGapMilliseconds: 2_000,
    eventDeduplicationWindowMilliseconds: 1_000,
    sameWindowCaptureGapMilliseconds: 5_000,
    visualOnlyCaptureGapMilliseconds: 15_000,
    delaysMilliseconds: {
      mouseClick: 400,
      focusedElementChanged: 500,
      keyActivity: 1_500,
      accessibilityChanged: 3_000,
      visualChanged: 750,
    },
    capsMilliseconds: {
      keyActivity: 30_000,
      visualChanged: 10_000,
    },
  },
  capture: {
    requestTimeoutMilliseconds: 10_000,
    reuseWindowMilliseconds: 250,
  },
  diagnostics: {
    retentionMilliseconds: 7 * 24 * 60 * 60_000,
  },
  helperLifecycle: {
    configurationTimeoutMilliseconds: 2_000,
    shutdownTimeoutMilliseconds: 500,
  },
  activityMonitoring: {
    coalescingIntervalMilliseconds: 250,
  },
  accessibility: {
    maxDepth: 40,
    maxNodes: 5_000,
    timeoutMilliseconds: 2_000,
    maxTextLength: 8_192,
  },
  screenshot: {
    maxWidth: 1_920,
    jpegQuality: 0.85,
  },
  visualMonitoring: {
    maxWidth: 320,
    sampleIntervalMilliseconds: 500,
    queueDepth: 2,
    changeThreshold: 0.05,
    signatureWidth: 32,
    signatureHeight: 18,
  },
  windowSelection: {
    minimumWidth: 160,
    minimumHeight: 120,
    maximumAspectRatio: 4,
  },
} satisfies ScreenObservationConfig;

test("forwards helper observations without retaining image data", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openscreen-observation-extension-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const helperPath = join(directory, "helper.mjs");
  await writeFile(helperPath, `
    import { createInterface } from "node:readline";
    const window = {
      processIdentifier: 100,
      bundleIdentifier: "com.example.Editor",
      applicationName: "Editor",
      windowIdentifier: 7,
      title: "Document",
    };
    process.stdout.write(JSON.stringify({
      type: "ready",
      processIdentifier: process.pid,
    }) + "\\n");
    const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
    for await (const line of lines) {
      const command = JSON.parse(line);
      if (command.type === "configure") {
        if (
          command.configuration.accessibility.maxDepth !== 40 ||
          command.configuration.activityMonitoring.coalescingIntervalMilliseconds !== 250 ||
          "captureThreshold" in command.configuration.visualMonitoring
        ) {
          throw new Error("Native configuration was not forwarded");
        }
        process.stdout.write(JSON.stringify({
          requestId: command.requestId,
          type: "configured",
        }) + "\\n");
        process.stdout.write(JSON.stringify({
          type: "status",
          component: "eventTap",
          status: "degraded",
          message: "Input Monitoring permission is unavailable",
        }) + "\\n");
        process.stdout.write(JSON.stringify({
          type: "signal",
          signal: {
            kind: "focusedWindowChanged",
            occurredAt: "2026-07-27T00:00:00.000Z",
            window,
          },
        }) + "\\n");
      }
      if (command.type === "capture") {
        process.stdout.write(JSON.stringify({
          requestId: command.requestId,
          type: "captureResult",
          result: {
            startedAt: "2026-07-27T00:00:00.900Z",
            capturedAt: "2026-07-27T00:00:01.000Z",
            validation: {
              preflightDurationMilliseconds: 2,
              attestationDurationMilliseconds: 1,
            },
            window,
            screenshot: {
              status: "permissionDenied",
              durationMilliseconds: 1,
              completedAt: "2026-07-27T00:00:00.950Z",
            },
            accessibility: {
              status: "complete",
              quality: "shell_only",
              durationMilliseconds: 1,
              completedAt: "2026-07-27T00:00:00.975Z",
              contentRootFound: false,
              semanticNodeCount: 0,
              usefulTextCharacters: 0,
              snapshot: {
                nodeCount: 1,
                truncated: false,
                root: { role: "AXWindow", title: "Document" },
              },
            },
          },
        }) + "\\n");
      }
      if (command.type === "shutdown") process.exit(0);
    }
  `);

  const statuses: string[] = [];
  const observations: ScreenObservation[] = [];
  const diagnostics: CaptureDiagnosticEvent[] = [];
  const extension = new ScreenObservationExtension({
    config: {
      ...config,
      capture: {
        ...config.capture,
        reuseWindowMilliseconds: 5_000,
      },
    },
    helperCommand: process.execPath,
    helperArguments: [helperPath],
    helperCurrentDirectory: directory,
    excludedProcessIdentifiers: [],
    excludedBundleIdentifiers: [],
    diagnostics: { emit: (event) => diagnostics.push(event) },
    onObservation: (observation) => {
      observations.push(observation);
    },
    onComponentStatus: (status) => {
      statuses.push(`${status.component}:${status.status}`);
    },
  });
  t.after(() => extension.stop());

  await extension.start();
  await waitFor(() => observations.length === 1);
  const recordedResolutions: string[] = [];
  const service = (extension as unknown as {
    service: {
      recordObservationResolution(
        artifact: { captureId: string },
        resolution: { decision: string },
      ): void;
    };
  }).service;
  const recordObservationResolution = service.recordObservationResolution.bind(
    service,
  );
  service.recordObservationResolution = (artifact, resolution) => {
    recordedResolutions.push(`${artifact.captureId}:${resolution.decision}`);
    recordObservationResolution(artifact, resolution);
  };
  const requestCapture = await extension.captureForRequest("request-1");

  assert.equal(observations[0]?.window.windowIdentifier, 7);
  assert.equal(requestCapture.capture.decision, "reuse");
  assert.equal(
    requestCapture.capture.artifact.captureId,
    observations[0]?.captureId,
  );
  assert.equal(requestCapture.observation?.decision, "reused");
  assert.equal(requestCapture.observation?.observationId, observations[0]?.id);
  assert.deepEqual(recordedResolutions, [
    `${requestCapture.capture.artifact.captureId}:reused`,
  ]);
  assert.equal(observations[0]?.visibleText, "");
  assert.equal(observations[0]?.screenshot.status, "permissionDenied");
  assert.deepEqual(statuses, ["eventTap:degraded"]);
  assert.ok(diagnostics.some((event) =>
    event.event === "helper.component_status" &&
    event.component === "eventTap" &&
    event.componentStatus === "degraded"
  ));
  assert.ok(diagnostics.some((event) =>
    event.event === "capture.decision" &&
    event.intentId === "request-1" &&
    event.decision === "reuse"
  ));
  assert.equal("latestObservation" in extension, false);

  const resolver = (extension as unknown as {
    observationResolver: { resolve: () => Promise<never> };
  }).observationResolver;
  resolver.resolve = async () => { throw new Error("persistence unavailable"); };
  const captureWithoutObservation = await extension.captureForRequest("request-2");
  assert.equal(captureWithoutObservation.capture.artifact.captureId, observations[0]?.captureId);
  assert.equal(captureWithoutObservation.observation, undefined);
  await extension.stop();
});

test("does not schedule activity capture for a signal without an exact window ID", () => {
  const diagnostics: CaptureDiagnosticEvent[] = [];
  const extension = new ScreenObservationExtension({
    config,
    helperCommand: process.execPath,
    helperCurrentDirectory: process.cwd(),
    excludedProcessIdentifiers: [],
    excludedBundleIdentifiers: [],
    diagnostics: { emit: (event) => diagnostics.push(event) },
  });
  const scheduled: NativeActivitySignal[] = [];
  const internals = extension as unknown as {
    push(signal: NativeActivitySignal): void;
    service: { push(signal: NativeActivitySignal): void };
  };
  internals.service.push = (signal) => scheduled.push(signal);
  const incomplete = {
    kind: "focusedWindowChanged" as const,
    occurredAt: "2026-08-07T00:00:00.000Z",
    window: {
      processIdentifier: 100,
      applicationName: "Editor",
    },
  };

  internals.push(incomplete);

  assert.deepEqual(scheduled, []);
  assert.ok(diagnostics.some((event) =>
    event.event === "activity.capture_skipped" &&
    event.activityRevision === 1 &&
    event.reason === "missing_window_identifier"
  ));
});

async function waitFor(check: () => boolean) {
  const deadline = Date.now() + 2_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for observation");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
