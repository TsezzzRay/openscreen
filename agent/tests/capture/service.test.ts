import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { CaptureConfig } from "../../src/capture/config.js";
import { NativeCaptureService } from "../../src/capture/service.js";
import type { CaptureDiagnosticEvent } from "../../src/capture/diagnostics.js";
import type { NativeActivitySignal } from "../../src/capture/native/protocol.js";

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
  requests: {
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
} satisfies CaptureConfig;

test("request capture returns neutral persisted image and bounded accessibility", async (t) => {
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
              status: "complete",
              durationMilliseconds: 1,
              completedAt: "2026-07-27T00:00:00.950Z",
              mimeType: "image/jpeg",
              dataBase64: "aW1hZ2U=",
              width: 100,
              height: 80,
            },
            accessibility: {
              status: "complete",
              quality: "useful",
              durationMilliseconds: 1,
              completedAt: "2026-07-27T00:00:00.975Z",
              contentRootFound: true,
              semanticNodeCount: 2,
              usefulTextCharacters: 12,
              snapshot: {
                nodeCount: 2,
                truncated: false,
                root: {
                  role: "AXWindow",
                  title: "Document",
                  children: [{ role: "AXStaticText", value: "Visible body" }],
                },
              },
            },
          },
        }) + "\\n");
      }
      if (command.type === "shutdown") process.exit(0);
    }
  `);

  const statuses: string[] = [];
  const diagnostics: CaptureDiagnosticEvent[] = [];
  const service = new NativeCaptureService({
    config: {
      ...config,
      requests: {
        ...config.requests,
        reuseWindowMilliseconds: 5_000,
      },
    },
    dataRoot: directory,
    helperCommand: process.execPath,
    helperArguments: [helperPath],
    helperCurrentDirectory: directory,
    excludedProcessIdentifiers: [],
    excludedBundleIdentifiers: [],
    diagnostics: { emit: (event) => diagnostics.push(event) },
    onComponentStatus: (status) => {
      statuses.push(`${status.component}:${status.status}`);
    },
  });
  t.after(() => service.stop());

  await service.start();
  await waitFor(() => Boolean((service as unknown as {
    coordinator: { freezeLatest(): unknown };
  }).coordinator.freezeLatest()));
  const context = await service.capture("request-1");

  assert.equal(context.requestId, "request-1");
  assert.equal(context.status, "complete");
  assert.equal(context.target.application.processIdentifier, 100);
  assert.equal(context.target.window.identifier, 7);
  assert.equal(context.image?.mimeType, "image/jpeg");
  assert.equal(await readFile(context.image!.path, "utf8"), "image");
  assert.equal(context.accessibility?.application, "Editor");
  assert.equal(context.accessibility?.visibleText, "Visible body");
  assert.ok(JSON.stringify(context.accessibility).length <= 10_000);
  assert.equal(context.diagnostics.screenshotStatus, "available");
  assert.equal(context.diagnostics.accessibilityStatus, "available");
  assert.deepEqual(statuses, ["eventTap:degraded"]);
  assert.ok(diagnostics.some((event) =>
    event.event === "helper.component_status" &&
    event.component === "eventTap" &&
    event.componentStatus === "degraded"
  ));
  assert.ok(diagnostics.some((event) =>
    event.event === "capture.decision" &&
    event.intentId === "request-1" &&
    event.decision !== undefined &&
    ["new", "join", "reuse"].includes(event.decision)
  ));
  assert.equal("latestObservation" in service, false);
  await service.stop();
});

test("does not schedule activity capture for a signal without an exact window ID", () => {
  const diagnostics: CaptureDiagnosticEvent[] = [];
  const service = new NativeCaptureService({
    config,
    dataRoot: process.cwd(),
    helperCommand: process.execPath,
    helperCurrentDirectory: process.cwd(),
    excludedProcessIdentifiers: [],
    excludedBundleIdentifiers: [],
    diagnostics: { emit: (event) => diagnostics.push(event) },
  });
  const scheduled: NativeActivitySignal[] = [];
  const internals = service as unknown as {
    push(signal: NativeActivitySignal): void;
    background: { push(signal: NativeActivitySignal): void };
  };
  internals.background.push = (signal) => scheduled.push(signal);
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

test("serializes concurrent starts into one helper start and one interval", async (t) => {
  const timers = fakeIntervals(t);
  const service = lifecycleService();
  const helper = lifecycleHelper(service);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let starts = 0;
  let stops = 0;
  helper.start = async () => {
    starts += 1;
    await gate;
  };
  helper.stop = async () => { stops += 1; };

  const first = service.start();
  const second = service.start();
  await Promise.resolve();
  release();
  await Promise.all([first, second]);

  assert.equal(starts, 1);
  assert.equal(timers.created, 1);
  assert.equal(timers.active.size, 1);
  await service.stop();
  assert.equal(stops, 1);
  assert.equal(timers.active.size, 0);
});

test("serializes stop behind an in-flight start without leaking an interval", async (t) => {
  const timers = fakeIntervals(t);
  const service = lifecycleService();
  const helper = lifecycleHelper(service);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let starts = 0;
  let stops = 0;
  helper.start = async () => {
    starts += 1;
    await gate;
  };
  helper.stop = async () => { stops += 1; };

  const starting = service.start();
  const stopping = service.stop();
  release();
  await Promise.all([starting, stopping]);

  assert.equal(starts, 1);
  assert.equal(stops, 1);
  assert.equal(timers.active.size, 0);
});

test("allows start to retry after helper startup fails", async (t) => {
  const timers = fakeIntervals(t);
  const service = lifecycleService();
  const helper = lifecycleHelper(service);
  let starts = 0;
  let stops = 0;
  helper.start = async () => {
    starts += 1;
    if (starts === 1) throw new Error("startup failed");
  };
  helper.stop = async () => { stops += 1; };

  await assert.rejects(service.start(), /startup failed/);
  await service.start();

  assert.equal(starts, 2);
  assert.equal(timers.created, 1);
  await service.stop();
  assert.equal(stops, 1);
});

test("coalesces repeated stops after one successful start", async (t) => {
  const timers = fakeIntervals(t);
  const service = lifecycleService();
  const helper = lifecycleHelper(service);
  let stops = 0;
  helper.start = async () => {};
  helper.stop = async () => { stops += 1; };
  await service.start();

  await Promise.all([service.stop(), service.stop()]);

  assert.equal(stops, 1);
  assert.equal(timers.active.size, 0);
});

function lifecycleService() {
  return new NativeCaptureService({
    config,
    dataRoot: process.cwd(),
    helperCommand: process.execPath,
    helperCurrentDirectory: process.cwd(),
    excludedProcessIdentifiers: [],
    excludedBundleIdentifiers: [],
    diagnostics: { emit: () => {} },
  });
}

function lifecycleHelper(service: NativeCaptureService) {
  return (service as unknown as {
    helper: {
      start(): Promise<void>;
      stop(): Promise<void>;
    };
  }).helper;
}

function fakeIntervals(t: { after(callback: () => void): void }) {
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const active = new Set<NodeJS.Timeout>();
  let created = 0;
  globalThis.setInterval = ((..._argumentsValue: unknown[]) => {
    created += 1;
    const timer = { created } as unknown as NodeJS.Timeout;
    active.add(timer);
    return timer;
  }) as unknown as typeof setInterval;
  globalThis.clearInterval = ((timer: NodeJS.Timeout) => {
    active.delete(timer);
  }) as unknown as typeof clearInterval;
  t.after(() => {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  });
  return {
    active,
    get created() { return created; },
  };
}

async function waitFor(check: () => boolean) {
  const deadline = Date.now() + 2_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for observation");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
