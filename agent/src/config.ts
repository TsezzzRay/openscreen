import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";

export type ScreenObservationConfig = {
  enabled: boolean;
  scheduling: {
    tickIntervalMilliseconds: number;
    ordinaryCaptureGapMilliseconds: number;
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
  deduplication: {
    visualDifferenceThreshold: number;
  };
  capture: {
    requestTimeoutMilliseconds: number;
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

export type RuntimeConfig = {
  apiKey: string;
  model: string;
  baseURL: string;
  context: {
    windowTokens: number;
    compactAtTokens: number;
    keepRecentTokens: number;
    maxOutputTokens: number;
    summaryMaxOutputTokens: number;
    minimumRecentTurns: number;
  };
  session: {
    eventFlushBytes: number;
    eventFlushMilliseconds: number;
  };
  timeline: {
    maxInputTokens: number;
    maxOutputTokens: number;
  };
  memory: {
    processingIntervalMinutes: number;
    maxInputTokens: number;
    maxOutputTokens: number;
  };
  screenObservation: ScreenObservationConfig;
};

const contextOverrides = {
  windowTokens: "OPENSCREEN_CONTEXT_WINDOW_TOKENS",
  compactAtTokens: "OPENSCREEN_COMPACT_AT_TOKENS",
  keepRecentTokens: "OPENSCREEN_KEEP_RECENT_TOKENS",
  maxOutputTokens: "OPENSCREEN_MAX_OUTPUT_TOKENS",
  summaryMaxOutputTokens: "OPENSCREEN_SUMMARY_MAX_OUTPUT_TOKENS",
  minimumRecentTurns: "OPENSCREEN_MIN_RECENT_TURNS",
} as const;

const sessionOverrides = {
  eventFlushBytes: "OPENSCREEN_SESSION_EVENT_FLUSH_BYTES",
  eventFlushMilliseconds: "OPENSCREEN_SESSION_EVENT_FLUSH_MS",
} as const;

const timelineOverrides = {
  maxInputTokens: "OPENSCREEN_TIMELINE_MAX_INPUT_TOKENS",
  maxOutputTokens: "OPENSCREEN_TIMELINE_MAX_OUTPUT_TOKENS",
} as const;

const memoryOverrides = {
  processingIntervalMinutes: "OPENSCREEN_MEMORY_PROCESSING_INTERVAL_MINUTES",
  maxInputTokens: "OPENSCREEN_MEMORY_MAX_INPUT_TOKENS",
  maxOutputTokens: "OPENSCREEN_MEMORY_MAX_OUTPUT_TOKENS",
} as const;

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, name: string) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}

function positiveInteger(value: unknown, name: string) {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return number;
}

function numericSection(
  file: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  name: string,
  overrides: Record<string, string>,
) {
  return Object.fromEntries(
    Object.entries(overrides).map(([setting, envName]) => [
      setting,
      positiveInteger(env[envName] ?? file[setting], `${name}.${setting}`),
    ]),
  );
}

function nonNegativeInteger(value: unknown, name: string) {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}

function positiveJSONInteger(value: unknown, name: string) {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function jsonIntegerInRange(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
) {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function boolean(value: unknown, name: string) {
  if (typeof value !== "boolean") {
    throw new Error(`${name} must be a boolean`);
  }
  return value;
}

function numberInRange(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
) {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function numberAtLeast(value: unknown, name: string, minimum: number) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum) {
    throw new Error(`${name} must be at least ${minimum}`);
  }
  return value;
}

function loadScreenObservationConfig(value: unknown): ScreenObservationConfig {
  const root = object(value, "screenObservation");
  const scheduling = object(root.scheduling, "screenObservation.scheduling");
  const delays = object(
    scheduling.delaysMilliseconds,
    "screenObservation.scheduling.delaysMilliseconds",
  );
  const caps = object(
    scheduling.capsMilliseconds,
    "screenObservation.scheduling.capsMilliseconds",
  );
  const deduplication = object(
    root.deduplication,
    "screenObservation.deduplication",
  );
  const capture = object(root.capture, "screenObservation.capture");
  const helperLifecycle = object(
    root.helperLifecycle,
    "screenObservation.helperLifecycle",
  );
  const activityMonitoring = object(
    root.activityMonitoring,
    "screenObservation.activityMonitoring",
  );
  const accessibility = object(root.accessibility, "screenObservation.accessibility");
  const screenshot = object(root.screenshot, "screenObservation.screenshot");
  const visualMonitoring = object(
    root.visualMonitoring,
    "screenObservation.visualMonitoring",
  );
  const windowSelection = object(
    root.windowSelection,
    "screenObservation.windowSelection",
  );

  const config: ScreenObservationConfig = {
    enabled: boolean(root.enabled, "screenObservation.enabled"),
    scheduling: {
      tickIntervalMilliseconds: positiveJSONInteger(
        scheduling.tickIntervalMilliseconds,
        "screenObservation.scheduling.tickIntervalMilliseconds",
      ),
      ordinaryCaptureGapMilliseconds: nonNegativeInteger(
        scheduling.ordinaryCaptureGapMilliseconds,
        "screenObservation.scheduling.ordinaryCaptureGapMilliseconds",
      ),
      delaysMilliseconds: {
        mouseClick: nonNegativeInteger(
          delays.mouseClick,
          "screenObservation.scheduling.delaysMilliseconds.mouseClick",
        ),
        focusedElementChanged: nonNegativeInteger(
          delays.focusedElementChanged,
          "screenObservation.scheduling.delaysMilliseconds.focusedElementChanged",
        ),
        keyActivity: nonNegativeInteger(
          delays.keyActivity,
          "screenObservation.scheduling.delaysMilliseconds.keyActivity",
        ),
        accessibilityChanged: nonNegativeInteger(
          delays.accessibilityChanged,
          "screenObservation.scheduling.delaysMilliseconds.accessibilityChanged",
        ),
        visualChanged: nonNegativeInteger(
          delays.visualChanged,
          "screenObservation.scheduling.delaysMilliseconds.visualChanged",
        ),
      },
      capsMilliseconds: {
        keyActivity: positiveJSONInteger(
          caps.keyActivity,
          "screenObservation.scheduling.capsMilliseconds.keyActivity",
        ),
        visualChanged: positiveJSONInteger(
          caps.visualChanged,
          "screenObservation.scheduling.capsMilliseconds.visualChanged",
        ),
      },
    },
    deduplication: {
      visualDifferenceThreshold: numberInRange(
        deduplication.visualDifferenceThreshold,
        "screenObservation.deduplication.visualDifferenceThreshold",
        0,
        1,
      ),
    },
    capture: {
      requestTimeoutMilliseconds: positiveJSONInteger(
        capture.requestTimeoutMilliseconds,
        "screenObservation.capture.requestTimeoutMilliseconds",
      ),
    },
    helperLifecycle: {
      configurationTimeoutMilliseconds: positiveJSONInteger(
        helperLifecycle.configurationTimeoutMilliseconds,
        "screenObservation.helperLifecycle.configurationTimeoutMilliseconds",
      ),
      shutdownTimeoutMilliseconds: positiveJSONInteger(
        helperLifecycle.shutdownTimeoutMilliseconds,
        "screenObservation.helperLifecycle.shutdownTimeoutMilliseconds",
      ),
    },
    activityMonitoring: {
      coalescingIntervalMilliseconds: positiveJSONInteger(
        activityMonitoring.coalescingIntervalMilliseconds,
        "screenObservation.activityMonitoring.coalescingIntervalMilliseconds",
      ),
    },
    accessibility: {
      maxDepth: nonNegativeInteger(
        accessibility.maxDepth,
        "screenObservation.accessibility.maxDepth",
      ),
      maxNodes: positiveJSONInteger(
        accessibility.maxNodes,
        "screenObservation.accessibility.maxNodes",
      ),
      timeoutMilliseconds: positiveJSONInteger(
        accessibility.timeoutMilliseconds,
        "screenObservation.accessibility.timeoutMilliseconds",
      ),
      maxTextLength: positiveJSONInteger(
        accessibility.maxTextLength,
        "screenObservation.accessibility.maxTextLength",
      ),
    },
    screenshot: {
      maxWidth: positiveJSONInteger(
        screenshot.maxWidth,
        "screenObservation.screenshot.maxWidth",
      ),
      jpegQuality: numberInRange(
        screenshot.jpegQuality,
        "screenObservation.screenshot.jpegQuality",
        0,
        1,
      ),
    },
    visualMonitoring: {
      maxWidth: positiveJSONInteger(
        visualMonitoring.maxWidth,
        "screenObservation.visualMonitoring.maxWidth",
      ),
      sampleIntervalMilliseconds: positiveJSONInteger(
        visualMonitoring.sampleIntervalMilliseconds,
        "screenObservation.visualMonitoring.sampleIntervalMilliseconds",
      ),
      queueDepth: jsonIntegerInRange(
        visualMonitoring.queueDepth,
        "screenObservation.visualMonitoring.queueDepth",
        1,
        8,
      ),
      changeThreshold: numberInRange(
        visualMonitoring.changeThreshold,
        "screenObservation.visualMonitoring.changeThreshold",
        0,
        1,
      ),
      signatureWidth: jsonIntegerInRange(
        visualMonitoring.signatureWidth,
        "screenObservation.visualMonitoring.signatureWidth",
        1,
        256,
      ),
      signatureHeight: jsonIntegerInRange(
        visualMonitoring.signatureHeight,
        "screenObservation.visualMonitoring.signatureHeight",
        1,
        256,
      ),
    },
    windowSelection: {
      minimumWidth: positiveJSONInteger(
        windowSelection.minimumWidth,
        "screenObservation.windowSelection.minimumWidth",
      ),
      minimumHeight: positiveJSONInteger(
        windowSelection.minimumHeight,
        "screenObservation.windowSelection.minimumHeight",
      ),
      maximumAspectRatio: numberAtLeast(
        windowSelection.maximumAspectRatio,
        "screenObservation.windowSelection.maximumAspectRatio",
        1,
      ),
    },
  };
  if (
    config.visualMonitoring.changeThreshold
      > config.deduplication.visualDifferenceThreshold
  ) {
    throw new Error(
      "screenObservation.visualMonitoring.changeThreshold must not exceed "
        + "screenObservation.deduplication.visualDifferenceThreshold",
    );
  }
  return config;
}

export function loadRuntimeConfig(
  configPath = resolve("config.json"),
  env: NodeJS.ProcessEnv = process.env,
): RuntimeConfig {
  const envPath = resolve(".env");
  if (env === process.env && existsSync(envPath)) loadEnvFile(envPath);

  const file = object(JSON.parse(readFileSync(configPath, "utf8")), "config");
  const fileContext = object(file.context, "context");
  const fileSession = object(file.session, "session");
  const fileTimeline = object(file.timeline, "timeline");
  const fileMemory = object(file.memory, "memory");
  const model = string(env.OPENAI_MODEL ?? file.model, "model");
  const baseURL = string(env.OPENAI_BASE_URL ?? file.baseURL, "baseURL");
  const apiKey = string(env.OPENAI_API_KEY, "OPENAI_API_KEY");
  if (/^<.*>$/.test(model)) throw new Error("model must be configured");
  if (/^<.*>$/.test(baseURL)) throw new Error("baseURL must be configured");

  let url: URL;
  try {
    url = new URL(baseURL);
  } catch {
    throw new Error("baseURL must be an HTTP or HTTPS URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("baseURL must be an HTTP or HTTPS URL");
  }

  const context = numericSection(
    fileContext,
    env,
    "context",
    contextOverrides,
  ) as RuntimeConfig["context"];
  const session = numericSection(
    fileSession,
    env,
    "session",
    sessionOverrides,
  ) as RuntimeConfig["session"];
  const timeline = numericSection(
    fileTimeline,
    env,
    "timeline",
    timelineOverrides,
  ) as RuntimeConfig["timeline"];
  const memory = numericSection(
    fileMemory,
    env,
    "memory",
    memoryOverrides,
  ) as RuntimeConfig["memory"];

  if (context.compactAtTokens >= context.windowTokens) {
    throw new Error("context.compactAtTokens must be less than windowTokens");
  }
  if (context.keepRecentTokens >= context.compactAtTokens) {
    throw new Error("context.keepRecentTokens must be less than compactAtTokens");
  }
  if (context.maxOutputTokens > context.windowTokens - context.compactAtTokens) {
    throw new Error("context.maxOutputTokens exceeds the available output budget");
  }
  if (timeline.maxInputTokens + timeline.maxOutputTokens > context.windowTokens) {
    throw new Error("timeline token budget exceeds context.windowTokens");
  }
  if (memory.maxInputTokens + memory.maxOutputTokens > context.windowTokens) {
    throw new Error("memory token budget exceeds context.windowTokens");
  }

  return {
    apiKey,
    model,
    baseURL,
    context,
    session,
    timeline,
    memory,
    screenObservation: loadScreenObservationConfig(file.screenObservation),
  };
}
