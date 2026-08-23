import { execFile } from "node:child_process";

/** What the helper prints on stdout. Every field is validated before use. */
export type HelperDisplay = {
  displayId: number;
  width: number;
  height: number;
  focused: boolean;
  path?: string;
  bytes?: number;
  pixelWidth?: number;
  pixelHeight?: number;
  error?: string;
};

export type HelperFocused = {
  appName: string;
  nodes: number;
  bundleId?: string;
  windowTitle?: string;
  text?: string;
  displayId?: number;
};

export type HelperReport = {
  capturedAt: string;
  displays: HelperDisplay[];
  focused?: HelperFocused;
  errors?: Record<string, string>;
};

export type HelperOptions = {
  helperPath: string;
  outDir: string;
  scale: number;
  quality: number;
  maxTextCharacters: number;
  excludeBundleIds: readonly string[];
  timeoutMilliseconds: number;
};

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Capture helper returned no ${field}`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requireNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Capture helper returned no ${field}`);
  }
  return value;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * The helper is trusted to be ours but not to be correct: a partial or
 * surprising payload becomes a capture failure, which the prompt survives, not
 * a malformed frame that reaches the model as fact.
 */
export function parseHelperReport(raw: string): HelperReport {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("Capture helper returned output that is not JSON");
  }
  if (typeof value !== "object" || value === null) {
    throw new Error("Capture helper returned a non-object");
  }
  const record = value as Record<string, unknown>;
  const displays: HelperDisplay[] = [];
  if (!Array.isArray(record["displays"])) {
    throw new Error("Capture helper returned no displays");
  }
  for (const entry of record["displays"]) {
    if (typeof entry !== "object" || entry === null) continue;
    const display = entry as Record<string, unknown>;
    displays.push({
      displayId: requireNumber(display["displayId"], "displayId"),
      width: requireNumber(display["width"], "width"),
      height: requireNumber(display["height"], "height"),
      focused: display["focused"] === true,
      ...(optionalString(display["path"]) === undefined
        ? {}
        : { path: optionalString(display["path"])! }),
      ...(optionalNumber(display["bytes"]) === undefined
        ? {}
        : { bytes: optionalNumber(display["bytes"])! }),
      ...(optionalNumber(display["pixelWidth"]) === undefined
        ? {}
        : { pixelWidth: optionalNumber(display["pixelWidth"])! }),
      ...(optionalNumber(display["pixelHeight"]) === undefined
        ? {}
        : { pixelHeight: optionalNumber(display["pixelHeight"])! }),
      ...(optionalString(display["error"]) === undefined
        ? {}
        : { error: optionalString(display["error"])! }),
    });
  }

  const report: HelperReport = {
    capturedAt: requireString(record["capturedAt"], "capturedAt"),
    displays,
  };

  const focusedRaw = record["focused"];
  if (typeof focusedRaw === "object" && focusedRaw !== null) {
    const focused = focusedRaw as Record<string, unknown>;
    const appName = optionalString(focused["appName"]);
    if (appName !== undefined) {
      report.focused = {
        appName,
        nodes: optionalNumber(focused["nodes"]) ?? 0,
        ...(optionalString(focused["bundleId"]) === undefined
          ? {}
          : { bundleId: optionalString(focused["bundleId"])! }),
        ...(optionalString(focused["windowTitle"]) === undefined
          ? {}
          : { windowTitle: optionalString(focused["windowTitle"])! }),
        ...(optionalString(focused["text"]) === undefined
          ? {}
          : { text: optionalString(focused["text"])! }),
        ...(optionalNumber(focused["displayId"]) === undefined
          ? {}
          : { displayId: optionalNumber(focused["displayId"])! }),
      };
    }
  }

  const errorsRaw = record["errors"];
  if (typeof errorsRaw === "object" && errorsRaw !== null) {
    const errors: Record<string, string> = {};
    for (const [key, value] of Object.entries(errorsRaw)) {
      const message = optionalString(value);
      if (message !== undefined) errors[key] = message;
    }
    if (Object.keys(errors).length > 0) report.errors = errors;
  }

  return report;
}

export function helperArguments(options: HelperOptions): string[] {
  const args = [
    "--out-dir",
    options.outDir,
    "--scale",
    String(options.scale),
    "--quality",
    String(options.quality),
    "--max-text",
    String(options.maxTextCharacters),
  ];
  for (const bundleId of options.excludeBundleIds) {
    args.push("--exclude-bundle", bundleId);
  }
  return args;
}

export type RunHelper = (options: HelperOptions, signal?: AbortSignal) => Promise<HelperReport>;

export const runHelper: RunHelper = (options, signal) =>
  new Promise((resolve, reject) => {
    execFile(
      options.helperPath,
      helperArguments(options),
      {
        timeout: options.timeoutMilliseconds,
        maxBuffer: 4_000_000,
        ...(signal === undefined ? {} : { signal }),
      },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        try {
          resolve(parseHelperReport(stdout));
        } catch (parseError) {
          reject(parseError);
        }
      },
    );
  });
