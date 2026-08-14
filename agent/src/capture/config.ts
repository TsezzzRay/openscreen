export type CaptureConfig = {
  enabled: boolean;
  scheduling: {
    tickIntervalMilliseconds: number;
    ordinaryCaptureGapMilliseconds: number;
    eventDeduplicationWindowMilliseconds: number;
    sameWindowCaptureGapMilliseconds: number;
    visualOnlyCaptureGapMilliseconds: number;
    delaysMilliseconds: {
      mouseClick: number;
      focusedElementChanged: number;
      keyActivity: number;
      accessibilityChanged: number;
      visualChanged: number;
    };
    capsMilliseconds: {
      keyActivity: number;
      visualChanged: number;
    };
  };
  requests: {
    requestTimeoutMilliseconds: number;
    reuseWindowMilliseconds: number;
  };
  diagnostics: {
    retentionMilliseconds: number;
  };
  helperLifecycle: {
    configurationTimeoutMilliseconds: number;
    shutdownTimeoutMilliseconds: number;
  };
  activityMonitoring: {
    coalescingIntervalMilliseconds: number;
  };
  accessibility: {
    maxDepth: number;
    maxNodes: number;
    timeoutMilliseconds: number;
    maxTextLength: number;
  };
  screenshot: {
    maxWidth: number;
    jpegQuality: number;
  };
  visualMonitoring: {
    maxWidth: number;
    sampleIntervalMilliseconds: number;
    queueDepth: number;
    changeThreshold: number;
    signatureWidth: number;
    signatureHeight: number;
  };
  windowSelection: {
    minimumWidth: number;
    minimumHeight: number;
    maximumAspectRatio: number;
  };
};

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("expected object");
  }
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: string[]): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error("unexpected configuration fields");
  }
}

function integer(value: unknown, minimum = 1, maximum = Number.MAX_SAFE_INTEGER) {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error("expected bounded integer");
  }
  return value;
}

function decimal(value: unknown, minimum: number, maximum: number) {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error("expected bounded number");
  }
  return value;
}

export function parseCaptureConfig(
  value: unknown,
): CaptureConfig {
  const root = record(value);
  exact(root, [
    "enabled",
    "scheduling",
    "requests",
    "diagnostics",
    "helperLifecycle",
    "activityMonitoring",
    "accessibility",
    "screenshot",
    "visualMonitoring",
    "windowSelection",
  ]);
  if (typeof root.enabled !== "boolean") throw new Error("expected boolean");

  const scheduling = record(root.scheduling);
  exact(scheduling, [
    "tickIntervalMilliseconds",
    "ordinaryCaptureGapMilliseconds",
    "eventDeduplicationWindowMilliseconds",
    "sameWindowCaptureGapMilliseconds",
    "visualOnlyCaptureGapMilliseconds",
    "delaysMilliseconds",
    "capsMilliseconds",
  ]);
  const delays = record(scheduling.delaysMilliseconds);
  exact(delays, [
    "mouseClick",
    "focusedElementChanged",
    "keyActivity",
    "accessibilityChanged",
    "visualChanged",
  ]);
  const caps = record(scheduling.capsMilliseconds);
  exact(caps, ["keyActivity", "visualChanged"]);

  const requests = record(root.requests);
  exact(requests, ["requestTimeoutMilliseconds", "reuseWindowMilliseconds"]);
  const diagnostics = record(root.diagnostics);
  exact(diagnostics, ["retentionMilliseconds"]);
  const helperLifecycle = record(root.helperLifecycle);
  exact(helperLifecycle, [
    "configurationTimeoutMilliseconds",
    "shutdownTimeoutMilliseconds",
  ]);
  const activityMonitoring = record(root.activityMonitoring);
  exact(activityMonitoring, ["coalescingIntervalMilliseconds"]);
  const accessibility = record(root.accessibility);
  exact(accessibility, [
    "maxDepth",
    "maxNodes",
    "timeoutMilliseconds",
    "maxTextLength",
  ]);
  const screenshot = record(root.screenshot);
  exact(screenshot, ["maxWidth", "jpegQuality"]);
  const visualMonitoring = record(root.visualMonitoring);
  exact(visualMonitoring, [
    "maxWidth",
    "sampleIntervalMilliseconds",
    "queueDepth",
    "changeThreshold",
    "signatureWidth",
    "signatureHeight",
  ]);
  const windowSelection = record(root.windowSelection);
  exact(windowSelection, [
    "minimumWidth",
    "minimumHeight",
    "maximumAspectRatio",
  ]);

  return {
    enabled: root.enabled,
    scheduling: {
      tickIntervalMilliseconds: integer(scheduling.tickIntervalMilliseconds),
      ordinaryCaptureGapMilliseconds: integer(
        scheduling.ordinaryCaptureGapMilliseconds,
        0,
      ),
      eventDeduplicationWindowMilliseconds: integer(
        scheduling.eventDeduplicationWindowMilliseconds,
        0,
      ),
      sameWindowCaptureGapMilliseconds: integer(
        scheduling.sameWindowCaptureGapMilliseconds,
        0,
      ),
      visualOnlyCaptureGapMilliseconds: integer(
        scheduling.visualOnlyCaptureGapMilliseconds,
      ),
      delaysMilliseconds: {
        mouseClick: integer(delays.mouseClick, 0),
        focusedElementChanged: integer(delays.focusedElementChanged, 0),
        keyActivity: integer(delays.keyActivity, 0),
        accessibilityChanged: integer(delays.accessibilityChanged, 0),
        visualChanged: integer(delays.visualChanged, 0),
      },
      capsMilliseconds: {
        keyActivity: integer(caps.keyActivity),
        visualChanged: integer(caps.visualChanged),
      },
    },
    requests: {
      requestTimeoutMilliseconds: integer(requests.requestTimeoutMilliseconds),
      reuseWindowMilliseconds: integer(requests.reuseWindowMilliseconds, 0),
    },
    diagnostics: {
      retentionMilliseconds: integer(diagnostics.retentionMilliseconds),
    },
    helperLifecycle: {
      configurationTimeoutMilliseconds: integer(
        helperLifecycle.configurationTimeoutMilliseconds,
      ),
      shutdownTimeoutMilliseconds: integer(
        helperLifecycle.shutdownTimeoutMilliseconds,
      ),
    },
    activityMonitoring: {
      coalescingIntervalMilliseconds: integer(
        activityMonitoring.coalescingIntervalMilliseconds,
      ),
    },
    accessibility: {
      maxDepth: integer(accessibility.maxDepth, 0),
      maxNodes: integer(accessibility.maxNodes),
      timeoutMilliseconds: integer(accessibility.timeoutMilliseconds),
      maxTextLength: integer(accessibility.maxTextLength),
    },
    screenshot: {
      maxWidth: integer(screenshot.maxWidth),
      jpegQuality: decimal(screenshot.jpegQuality, 0, 1),
    },
    visualMonitoring: {
      maxWidth: integer(visualMonitoring.maxWidth),
      sampleIntervalMilliseconds: integer(
        visualMonitoring.sampleIntervalMilliseconds,
      ),
      queueDepth: integer(visualMonitoring.queueDepth, 1, 8),
      changeThreshold: decimal(visualMonitoring.changeThreshold, 0, 1),
      signatureWidth: integer(visualMonitoring.signatureWidth, 1, 256),
      signatureHeight: integer(visualMonitoring.signatureHeight, 1, 256),
    },
    windowSelection: {
      minimumWidth: integer(windowSelection.minimumWidth),
      minimumHeight: integer(windowSelection.minimumHeight),
      maximumAspectRatio: decimal(
        windowSelection.maximumAspectRatio,
        1,
        Number.MAX_VALUE,
      ),
    },
  };
}
