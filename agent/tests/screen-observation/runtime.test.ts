import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ScreenObservationConfig } from "../../src/config.js";
import { ScreenObservationRuntime } from "../../src/screen-observation/runtime.js";
import type { ScreenObservation } from "../../src/screen-observation/types.js";

const config = {
  enabled: true,
  scheduling: {
    tickIntervalMilliseconds: 5,
    ordinaryCaptureGapMilliseconds: 2_000,
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
  deduplication: {
    visualDifferenceThreshold: 0.08,
  },
  capture: {
    requestTimeoutMilliseconds: 10_000,
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
    changeThreshold: 0.015,
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
  const directory = await mkdtemp(join(tmpdir(), "openscreen-observation-runtime-"));
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
          command.configuration.activityMonitoring.coalescingIntervalMilliseconds !== 250
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
            capturedAt: "2026-07-27T00:00:01.000Z",
            window,
            screenshot: {
              status: "permissionDenied",
              durationMilliseconds: 1,
            },
            accessibility: {
              status: "complete",
              durationMilliseconds: 1,
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
  const runtime = new ScreenObservationRuntime({
    config,
    helperCommand: process.execPath,
    helperArguments: [helperPath],
    helperCurrentDirectory: directory,
    excludedProcessIdentifiers: [],
    excludedBundleIdentifiers: [],
    onObservation: (observation) => observations.push(observation),
    onComponentStatus: (status) => {
      statuses.push(`${status.component}:${status.status}`);
    },
  });
  t.after(() => runtime.stop());

  await runtime.start();
  await waitFor(() => observations.length === 1);

  assert.equal(observations[0]?.window.windowIdentifier, 7);
  assert.equal(observations[0]?.visibleText, "Document");
  assert.equal(observations[0]?.screenshot.status, "permissionDenied");
  assert.deepEqual(statuses, ["eventTap:degraded"]);
  assert.equal("latestObservation" in runtime, false);
  await runtime.stop();
});

async function waitFor(check: () => boolean) {
  const deadline = Date.now() + 2_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for observation");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
