export type ScreenpipeCaptureConfig = {
  enabled: boolean;
  ignoredWindows: string[];
  ignoredUrls: string[];
  retention: {
    maxAgeMilliseconds: number;
    maxBytes: number;
  };
};

function invalid(): never {
  throw new Error("Invalid Screenpipe capture config");
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalid();
  }
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    invalid();
  }
}

function positiveInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    return invalid();
  }
  return value;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 256) return invalid();
  const result = value.map((item) => {
    if (typeof item !== "string") return invalid();
    const text = item.trim();
    if (!text || Array.from(text).length > 2_048) return invalid();
    return text;
  });
  if (new Set(result).size !== result.length) return invalid();
  return result;
}

export function parseScreenpipeCaptureConfig(
  value: unknown,
): ScreenpipeCaptureConfig {
  const root = record(value);
  exact(root, ["enabled", "ignoredWindows", "ignoredUrls", "retention"]);
  if (typeof root.enabled !== "boolean") invalid();
  const retention = record(root.retention);
  exact(retention, ["maxAgeMilliseconds", "maxBytes"]);
  return {
    enabled: root.enabled,
    ignoredWindows: stringList(root.ignoredWindows),
    ignoredUrls: stringList(root.ignoredUrls),
    retention: {
      maxAgeMilliseconds: positiveInteger(retention.maxAgeMilliseconds),
      maxBytes: positiveInteger(retention.maxBytes),
    },
  };
}
