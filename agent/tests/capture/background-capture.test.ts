import assert from "node:assert/strict";
import test from "node:test";

import type { CaptureConfig } from "../../src/capture/config.js";
import type { CaptureArtifact } from "../../src/capture/artifact.js";
import { ObservationResolver } from "../../src/capture/observation-resolver.js";
import { BackgroundCapture } from "../../src/capture/background-capture.js";
import type {
  NativeActivitySignal,
  NativeCaptureResult,
} from "../../src/capture/native/protocol.js";
import type {
  ScreenObservation,
} from "../../src/capture/observation.js";
import type {
  CaptureDiagnosticEvent,
} from "../../src/capture/diagnostics.js";

const config = {
  enabled: true,
  scheduling: {
    tickIntervalMilliseconds: 100,
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

const windowA = {
  processIdentifier: 100,
  bundleIdentifier: "com.example.Browser",
  applicationName: "Browser",
  windowIdentifier: 7,
  title: "Example",
};
const windowB = {
  ...windowA,
  processIdentifier: 200,
  windowIdentifier: 9,
  title: "Other",
};

function signal(
  kind: NativeActivitySignal["kind"],
  window = windowA,
  occurredAtMilliseconds = 0,
  visualSignature?: number[],
): NativeActivitySignal {
  return {
    kind,
    occurredAt: new Date(occurredAtMilliseconds).toISOString(),
    window,
    ...(visualSignature === undefined ? {} : { visualSignature }),
  };
}

function result(
  window = windowA,
  title = "Example",
  visualSignature = [0, 0, 0, 0],
): NativeCaptureResult {
  return {
    capturedAt: "2026-07-27T00:00:01.000Z",
    validation: {
      preflightDurationMilliseconds: 2,
      attestationDurationMilliseconds: 1,
    },
    window,
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
        nodeCount: 4,
        truncated: false,
        root: {
          role: "AXWindow",
          title,
          children: [
            { role: "AXStaticText", value: "Visible body" },
            {
              role: "AXTextField",
              identifier: "address-field",
              value: "https://example.com/page",
              focused: true,
            },
            { role: "AXStaticText", value: "Visible body" },
          ],
        },
      },
    },
    visualSignature,
  };
}

function makeService(options: {
  config?: CaptureConfig;
  capture: (source: NativeActivitySignal) => NativeCaptureResult | Promise<NativeCaptureResult>;
  onObservation?: (observation: ScreenObservation) => void | Promise<void>;
  diagnostics?: { emit(event: CaptureDiagnosticEvent): void };
}) {
  let captureSequence = 0;
  const resolver = new ObservationResolver({
    makeObservationId: () => "observation-" + String(captureSequence),
    persist: (observation) => options.onObservation?.(observation),
  });
  return new BackgroundCapture({
    config: options.config ?? config,
    capture: async (source): Promise<CaptureArtifact> => {
      const captureResult = await options.capture(source);
      captureSequence += 1;
      return {
        captureId: "capture-" + String(captureSequence),
        activityRevision: captureSequence,
        completedActivityRevision: captureSequence,
        contentEpoch: captureSequence,
        completedContentEpoch: captureSequence,
        signal: source,
        target: source.window,
        result: captureResult,
        status: "complete",
        completedAtMilliseconds: Date.parse(captureResult.capturedAt),
      };
    },
    resolveObservation: (capture) => resolver.resolve(capture),
    diagnostics: options.diagnostics,
  });
}

test("records whether an activity was scheduled or deduplicated", () => {
  const diagnostics: CaptureDiagnosticEvent[] = [];
  const service = makeService({
    capture: async () => result(),
    diagnostics: { emit: (event) => diagnostics.push(event) },
  });

  service.push(signal("mouseClick"), 0, 42);
  service.push(signal("mouseClick", windowA, 300), 300, 43);

  assert.deepEqual(
    diagnostics.map(({ event, activityKind, activityRevision, plannerDecision }) => ({
      event,
      activityKind,
      activityRevision,
      plannerDecision,
    })),
    [
      {
        event: "activity.planner_decision",
        activityKind: "mouseClick",
        activityRevision: 42,
        plannerDecision: "scheduled",
      },
      {
        event: "activity.planner_decision",
        activityKind: "mouseClick",
        activityRevision: 43,
        plannerDecision: "deduplicated",
      },
    ],
  );
});

test("advances content epoch only for visual changes that cross the persisted threshold", () => {
  const service = makeService({ capture: async () => result() });
  const baselineSignal = signal("mouseClick");
  const baselineResult = result(windowA, "Example", [0, 0, 0, 0]);
  const baselineArtifact: CaptureArtifact = {
    captureId: "capture-baseline",
    activityRevision: 1,
    completedActivityRevision: 1,
    contentEpoch: 1,
    completedContentEpoch: 1,
    signal: baselineSignal,
    target: windowA,
    result: baselineResult,
    status: "complete",
    completedAtMilliseconds: 0,
  };
  service.cover(baselineArtifact);
  service.recordObservationResolution(baselineArtifact, {
    decision: "created",
    observationId: "observation-baseline",
  });

  assert.equal(
    service.shouldAdvanceContentEpoch(
      signal("visualChanged", windowA, 1, [1, 1, 1, 1]),
    ),
    false,
  );
  assert.equal(
    service.shouldAdvanceContentEpoch(
      signal("visualChanged", windowA, 2, [255, 255, 255, 255]),
    ),
    true,
  );
  assert.equal(
    service.shouldAdvanceContentEpoch(signal("visualChanged", windowA, 3)),
    false,
  );
  assert.equal(service.shouldAdvanceContentEpoch(signal("keyActivity")), true);
});

test("does not advance the visual baseline when request coverage has not been persisted", () => {
  const service = makeService({ capture: async () => result() });
  const baselineSignal = signal("mouseClick");
  service.cover({
    captureId: "request-capture",
    activityRevision: 1,
    completedActivityRevision: 1,
    contentEpoch: 1,
    completedContentEpoch: 1,
    signal: baselineSignal,
    target: windowA,
    result: result(windowA, "Example", [0, 0, 0, 0]),
    status: "complete",
    completedAtMilliseconds: 0,
  });

  assert.equal(
    service.shouldAdvanceContentEpoch(
      signal("visualChanged", windowA, 1, [1, 1, 1, 1]),
    ),
    true,
  );
});

test("commits a request visual baseline after its observation is created", () => {
  const service = makeService({ capture: async () => result() });
  const baselineSignal = signal("mouseClick");
  const artifact: CaptureArtifact = {
    captureId: "request-capture",
    activityRevision: 1,
    completedActivityRevision: 1,
    contentEpoch: 1,
    completedContentEpoch: 1,
    signal: baselineSignal,
    target: windowA,
    result: result(windowA, "Example", [0, 0, 0, 0]),
    status: "complete",
    completedAtMilliseconds: 0,
  };
  service.cover(artifact);

  service.recordObservationResolution(artifact, {
    decision: "created",
    observationId: "observation-1",
  });

  assert.equal(
    service.shouldAdvanceContentEpoch(
      signal("visualChanged", windowA, 1, [1, 1, 1, 1]),
    ),
    false,
  );
});

test("a request capture covers pending activity for the same window and revision", async () => {
  let captureCount = 0;
  const diagnostics: CaptureDiagnosticEvent[] = [];
  const service = makeService({
    capture: async () => {
      captureCount += 1;
      return result();
    },
    diagnostics: { emit: (event) => diagnostics.push(event) },
  });
  const source = signal("mouseClick");
  service.push(source, 0, 1);
  const captureResult = result();

  service.cover({
    captureId: "request-capture",
    activityRevision: 1,
    completedActivityRevision: 1,
    contentEpoch: 1,
    completedContentEpoch: 1,
    signal: source,
    target: source.window,
    result: captureResult,
    status: "complete",
    completedAtMilliseconds: 200,
  });
  await service.tick(400);

  assert.equal(captureCount, 0);
  const covered = diagnostics.find(({ event }) =>
    event === "activity.covered_by_request"
  );
  assert.equal(covered?.captureId, "request-capture");
  assert.equal(covered?.coveredPendingCount, 1);
  assert.equal(covered?.coveredDeferred, false);
});

test("request coverage uses the request intent revision instead of the artifact revision", async () => {
  let captureCount = 0;
  const diagnostics: CaptureDiagnosticEvent[] = [];
  const service = makeService({
    capture: async () => {
      captureCount += 1;
      return result();
    },
    diagnostics: { emit: (event) => diagnostics.push(event) },
  });
  const source = signal("mouseClick");
  service.push(source, 0, 2);

  service.cover({
    captureId: "older-artifact",
    activityRevision: 1,
    completedActivityRevision: 2,
    contentEpoch: 1,
    completedContentEpoch: 1,
    signal: source,
    target: source.window,
    result: result(),
    status: "complete",
    completedAtMilliseconds: 200,
  }, 2, "mouseClick", 5);
  await service.tick(400);

  assert.equal(captureCount, 0);
  const covered = diagnostics.find(({ event }) =>
    event === "activity.covered_by_request"
  );
  assert.equal(covered?.activityRevision, 2);
  assert.equal(covered?.artifactRevision, 1);
  assert.equal(covered?.contentEpoch, 5);
  assert.equal(covered?.coveredPendingCount, 1);
});

test("activity after request coverage can schedule inside the old deduplication window", async () => {
  let captureCount = 0;
  const service = makeService({
    config: {
      ...config,
      scheduling: {
        ...config.scheduling,
        ordinaryCaptureGapMilliseconds: 0,
        sameWindowCaptureGapMilliseconds: 0,
      },
    },
    capture: async () => {
      captureCount += 1;
      return result();
    },
  });
  const first = signal("mouseClick");
  service.push(first, 0, 1);
  const requestResult = result();
  service.cover({
    captureId: "request-capture",
    activityRevision: 1,
    completedActivityRevision: 1,
    contentEpoch: 1,
    completedContentEpoch: 1,
    signal: first,
    target: first.window,
    result: requestResult,
    status: "complete",
    completedAtMilliseconds: 200,
  });

  service.push(signal("mouseClick", windowA, 300), 300, 2);
  await service.tick(700);

  assert.equal(captureCount, 1);
});

test("activity after request coverage can replace a due capture deferred by the gap", async () => {
  let captureCount = 0;
  const service = makeService({
    config: {
      ...config,
      scheduling: {
        ...config.scheduling,
        ordinaryCaptureGapMilliseconds: 1_000,
        sameWindowCaptureGapMilliseconds: 1_000,
      },
    },
    capture: async () => {
      captureCount += 1;
      return result();
    },
  });
  const first = signal("mouseClick");
  const initialResult = result();
  service.cover({
    captureId: "initial-request",
    activityRevision: 0,
    completedActivityRevision: 0,
    contentEpoch: 0,
    completedContentEpoch: 0,
    signal: first,
    target: first.window,
    result: initialResult,
    status: "complete",
    completedAtMilliseconds: 0,
  });
  service.push(first, 0, 1);
  await service.tick(400);

  const coveringResult = result();
  service.cover({
    captureId: "covering-request",
    activityRevision: 1,
    completedActivityRevision: 1,
    contentEpoch: 1,
    completedContentEpoch: 1,
    signal: first,
    target: first.window,
    result: coveringResult,
    status: "complete",
    completedAtMilliseconds: 500,
  });
  service.push(signal("mouseClick", windowA, 600), 600, 2);
  await service.tick(1_500);

  assert.equal(captureCount, 1);
});

test("builds a normalized observation without persisting it", async () => {
  const observations: ScreenObservation[] = [];
  const service = makeService({
    capture: async () => result(),
    onObservation: (observation) => {
      observations.push(observation);
    },
  });

  service.push(signal("mouseClick"), 0);
  await service.tick(400);

  assert.equal(observations.length, 1);
  assert.equal(observations[0]?.schemaVersion, 1);
  assert.equal(observations[0]?.captureId, "capture-1");
  assert.equal(observations[0]?.activityRevision, 1);
  assert.equal(observations[0]?.trigger.type, "mouseClick");
  assert.equal(observations[0]?.window.windowIdentifier, 7);
  assert.equal(observations[0]?.screenshot.sha256?.length, 64);
  assert.equal(observations[0]?.focusedElement?.identifier, "address-field");
  assert.equal(observations[0]?.visibleText, "Example\nVisible body\nhttps://example.com/page");
  assert.equal(observations[0]?.url, "https://example.com/page");
});

test("drops unchanged ordinary observations but retains a real window boundary", async () => {
  const observations: ScreenObservation[] = [];
  const captures = [result(), result(windowB, "Other")];
  const service = makeService({
    capture: async () => captures.shift()!,
    onObservation: (observation) => {
      observations.push(observation);
    },
  });

  service.push(signal("mouseClick"), 0);
  await service.tick(400);
  service.push(signal("mouseClick", windowA, 2_100), 2_100);
  await service.tick(2_500);
  service.push(signal("focusedWindowChanged", windowB, 2_600), 2_600);
  await service.tick(2_600);

  assert.deepEqual(
    observations.map((observation) => observation.window.windowIdentifier),
    [7, 9],
  );
});

test("enforces the same-window five second capture gap without dropping the latest signal", async () => {
  let captureCount = 0;
  const service = makeService({
    capture: async () => {
      captureCount += 1;
      return result(windowA, `Capture ${captureCount}`, [captureCount, 0, 0, 0]);
    },
    onObservation: () => {},
  });

  service.push(signal("mouseClick"), 0);
  await service.tick(400);
  service.push(signal("mouseClick", windowA, 1_500), 1_500);
  await service.tick(1_900);
  await service.tick(5_399);
  assert.equal(captureCount, 1);

  await service.tick(5_400);
  assert.equal(captureCount, 2);
});

test("tracks failed capture backoff separately from successful capture gaps", async () => {
  let captureCount = 0;
  const diagnostics: CaptureDiagnosticEvent[] = [];
  const service = makeService({
    config: {
      ...config,
      scheduling: {
        ...config.scheduling,
        ordinaryCaptureGapMilliseconds: 5_000,
        eventDeduplicationWindowMilliseconds: 0,
        sameWindowCaptureGapMilliseconds: 5_000,
        delaysMilliseconds: {
          ...config.scheduling.delaysMilliseconds,
          mouseClick: 0,
        },
      },
    },
    capture: async () => {
      captureCount += 1;
      if (captureCount === 1) {
        throw Object.assign(new Error("capture failed"), {
          code: "capture_failed",
        });
      }
      return result(windowA, `Capture ${captureCount}`);
    },
    diagnostics: { emit: (event) => diagnostics.push(event) },
  });

  service.push(signal("mouseClick"), 0);
  await assert.rejects(service.tick(0));

  service.push(signal("mouseClick", windowA, 100), 100);
  await service.tick(100);
  await service.tick(999);
  assert.equal(captureCount, 1);
  assert.ok(diagnostics.some((event) =>
    event.event === "activity.rate_limited" &&
    event.reason === "failure_backoff" &&
    event.nextEligibleMs === 900
  ));

  await service.tick(1_000);
  assert.equal(captureCount, 2);

  service.push(signal("mouseClick", windowA, 1_100), 1_100);
  await service.tick(1_100);
  assert.equal(captureCount, 2);
  assert.ok(diagnostics.some((event) =>
    event.event === "activity.rate_limited" &&
    event.reason === "same_window_gap"
  ));
});

test("lets focus boundaries bypass same-window and global capture gaps", async () => {
  let captureCount = 0;
  const service = makeService({
    capture: async () => {
      captureCount += 1;
      return result(windowA, "Same content");
    },
    onObservation: () => {},
  });

  service.push(signal("mouseClick"), 0);
  await service.tick(400);
  service.push(signal("focusedWindowChanged", windowA, 500), 500);
  await service.tick(500);

  assert.equal(captureCount, 2);
});

test("uses the ordinary capture gap supplied by startup configuration", async () => {
  let captureCount = 0;
  const service = makeService({
    config: {
      ...config,
      scheduling: {
        ...config.scheduling,
        ordinaryCaptureGapMilliseconds: 100,
        eventDeduplicationWindowMilliseconds: 0,
        sameWindowCaptureGapMilliseconds: 100,
      },
    },
    capture: async () => {
      captureCount += 1;
      return result(windowA, `Capture ${captureCount}`, [captureCount, 0, 0, 0]);
    },
    onObservation: () => {},
  });

  service.push(signal("mouseClick"), 0);
  await service.tick(400);
  service.push(signal("mouseClick", windowA, 500), 500);
  await service.tick(900);

  assert.equal(captureCount, 2);
});

test("rejects insignificant visual activity before starting a physical capture", async () => {
  let captureCount = 0;
  const service = makeService({
    config: {
      ...config,
      scheduling: {
        ...config.scheduling,
        ordinaryCaptureGapMilliseconds: 0,
        sameWindowCaptureGapMilliseconds: 0,
      },
    },
    capture: async () => {
      captureCount += 1;
      return result(windowA, "Capture", [0, 0, 0, 0]);
    },
    onObservation: () => {},
  });

  service.push(signal("mouseClick"), 0);
  await service.tick(400);
  service.push(signal("visualChanged", windowA, 1_000, [10, 10, 10, 10]), 1_000);
  await service.tick(20_000);

  assert.equal(captureCount, 1);
});

test("an insignificant latest visual frame cancels an older pending candidate", async () => {
  let captureCount = 0;
  const diagnostics: CaptureDiagnosticEvent[] = [];
  const service = makeService({
    config: {
      ...config,
      scheduling: {
        ...config.scheduling,
        ordinaryCaptureGapMilliseconds: 0,
        sameWindowCaptureGapMilliseconds: 0,
      },
    },
    capture: async () => {
      captureCount += 1;
      return result(windowA, "Capture", [0, 0]);
    },
    onObservation: () => {},
    diagnostics: { emit: (event) => diagnostics.push(event) },
  });

  service.push(signal("mouseClick"), 0, 1);
  await service.tick(400);
  service.push(signal("visualChanged", windowA, 1_000, [255, 255]), 1_000, 2);
  service.push(signal("visualChanged", windowA, 1_200, [0, 0]), 1_200, 3);
  await service.tick(20_000);

  assert.equal(captureCount, 1);
  assert.ok(diagnostics.some((event) =>
    event.event === "activity.due_collapsed" &&
    event.activityRevision === 2 &&
    event.reason === "visual_baseline_recovered"
  ));
});

test("keeps the latest significant visual signal until the visual-only gap expires", async () => {
  let captureCount = 0;
  const capturedSignals: NativeActivitySignal[] = [];
  const diagnostics: CaptureDiagnosticEvent[] = [];
  const service = makeService({
    config: {
      ...config,
      scheduling: {
        ...config.scheduling,
        ordinaryCaptureGapMilliseconds: 0,
        sameWindowCaptureGapMilliseconds: 0,
        visualOnlyCaptureGapMilliseconds: 15_000,
      },
    },
    capture: async (source) => {
      capturedSignals.push(source);
      captureCount += 1;
      return result(windowA, "Capture", source.visualSignature ?? [0, 0]);
    },
    onObservation: () => {},
    diagnostics: { emit: (event) => diagnostics.push(event) },
  });

  service.push(signal("mouseClick"), 0);
  await service.tick(400);
  service.push(signal("visualChanged", windowA, 1_000, [255, 0]), 1_000);
  await service.tick(1_750);
  service.push(signal("visualChanged", windowA, 10_000, [255, 255]), 10_000);
  await service.tick(14_999);
  assert.equal(captureCount, 1);

  await service.tick(15_400);
  assert.equal(captureCount, 2);
  assert.deepEqual(capturedSignals.at(-1)?.visualSignature, [255, 255]);
  assert.equal(
    diagnostics.filter(({ event }) => event === "activity.rate_limited").length,
    2,
  );
  assert.equal(
    diagnostics.find(({ event }) => event === "activity.rate_limited")?.reason,
    "visual_only_gap",
  );
});

test("selects explicit input over visual work due on the same tick", async () => {
  const diagnostics: CaptureDiagnosticEvent[] = [];
  const capturedKinds: NativeActivitySignal["kind"][] = [];
  const service = makeService({
    config: {
      ...config,
      scheduling: {
        ...config.scheduling,
        ordinaryCaptureGapMilliseconds: 0,
        sameWindowCaptureGapMilliseconds: 0,
      },
    },
    capture: async (source) => {
      capturedKinds.push(source.kind);
      return result();
    },
    onObservation: () => {},
    diagnostics: { emit: (event) => diagnostics.push(event) },
  });

  service.push(signal("visualChanged", windowA, 0, [255, 255]), 0, 1);
  service.push(signal("mouseClick", windowA, 350), 350, 2);
  await service.tick(750);

  assert.deepEqual(capturedKinds, ["mouseClick"]);
  assert.ok(diagnostics.some((event) =>
    event.event === "activity.due_selected" &&
    event.activityRevision === 2
  ));
  assert.ok(diagnostics.some((event) =>
    event.event === "activity.due_collapsed" &&
    event.activityRevision === 1 &&
    event.reason === "higher_priority_due"
  ));
});

test("records delayed work superseded by a boundary", () => {
  const diagnostics: CaptureDiagnosticEvent[] = [];
  const service = makeService({
    capture: async () => result(),
    diagnostics: { emit: (event) => diagnostics.push(event) },
  });

  service.push(signal("visualChanged", windowA, 0, [255, 255]), 0, 1);
  service.push(signal("focusedWindowChanged", windowA, 100), 100, 2);

  assert.ok(diagnostics.some((event) =>
    event.event === "activity.boundary_superseded" &&
    event.activityRevision === 1 &&
    event.reason === "focusedWindowChanged"
  ));
});

test("does not apply the visual-only gap to explicit user activity", async () => {
  let captureCount = 0;
  const service = makeService({
    config: {
      ...config,
      scheduling: {
        ...config.scheduling,
        ordinaryCaptureGapMilliseconds: 0,
        sameWindowCaptureGapMilliseconds: 0,
        visualOnlyCaptureGapMilliseconds: 15_000,
      },
    },
    capture: async () => {
      captureCount += 1;
      return result();
    },
    onObservation: () => {},
  });

  service.push(signal("mouseClick"), 0);
  await service.tick(400);
  service.push(signal("mouseClick", windowA, 1_500), 1_500);
  await service.tick(1_900);

  assert.equal(captureCount, 2);
});

test("retries the same observation after persistence fails before advancing dedupe", async () => {
  const observationIds: string[] = [];
  let deliveryAttempts = 0;
  const service = makeService({
    capture: async () => result(),
    onObservation: (observation) => {
      observationIds.push(observation.id);
      deliveryAttempts += 1;
      if (deliveryAttempts === 1) {
        throw new Error("transient persistence failure");
      }
    },
  });

  service.push(signal("mouseClick"), 0);
  await assert.rejects(service.tick(400), /transient persistence failure/);
  await service.tick(2_399);
  assert.equal(deliveryAttempts, 1);

  await service.tick(2_400);
  assert.equal(deliveryAttempts, 2);
  assert.equal(observationIds[0], observationIds[1]);

  service.push(signal("mouseClick", windowA, 4_100), 4_100);
  await service.tick(4_500);
  assert.equal(deliveryAttempts, 2);
});

test("commits the visual baseline only after observation persistence succeeds", async () => {
  let persistenceAttempts = 0;
  const service = makeService({
    capture: async () => result(windowA, "Example", [0, 0, 0, 0]),
    onObservation: () => {
      persistenceAttempts += 1;
      if (persistenceAttempts === 1) {
        throw new Error("persistence unavailable");
      }
    },
  });

  service.push(signal("mouseClick"), 0);
  await assert.rejects(service.tick(400), /persistence unavailable/);
  assert.equal(
    service.shouldAdvanceContentEpoch(
      signal("visualChanged", windowA, 500, [1, 1, 1, 1]),
    ),
    true,
  );

  await service.tick(2_400);
  assert.equal(
    service.shouldAdvanceContentEpoch(
      signal("visualChanged", windowA, 2_500, [1, 1, 1, 1]),
    ),
    false,
  );
});

test("does not apply capture failure backoff after only persistence fails", async () => {
  let captures = 0;
  let persistenceAttempts = 0;
  const service = makeService({
    config: {
      ...config,
      scheduling: {
        ...config.scheduling,
        ordinaryCaptureGapMilliseconds: 0,
        eventDeduplicationWindowMilliseconds: 0,
        sameWindowCaptureGapMilliseconds: 0,
        delaysMilliseconds: {
          ...config.scheduling.delaysMilliseconds,
          mouseClick: 0,
        },
      },
    },
    capture: async () => {
      captures += 1;
      return result(windowA, `Capture ${captures}`);
    },
    onObservation: () => {
      persistenceAttempts += 1;
      if (persistenceAttempts === 1) {
        throw new Error("persistence unavailable");
      }
    },
  });

  service.push(signal("mouseClick"), 0);
  await assert.rejects(service.tick(0));
  await service.tick(1);

  service.push(signal("mouseClick", windowA, 2), 2);
  await service.tick(2);

  assert.equal(captures, 2);
});
