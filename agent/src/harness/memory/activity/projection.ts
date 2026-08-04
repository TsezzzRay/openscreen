import type { ScreenObservation } from "../../../plugins/screen-observation/types.js";
import {
  MEMORY_SCOPE_TYPES,
  type MemoryScopeHint,
  type ObservationProjection,
  type ActivityRecordOutput,
  type ActivityOutput,
  type ActivitySource,
  type TerminalTurnStatus,
  type TurnBatchProjection,
} from "./types.js";

const TOOL_RESULT_MAX_CHARACTERS = 2_000;
const SCOPE_TYPES = new Set<string>(MEMORY_SCOPE_TYPES);

function definedEntries<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as T;
}

export function projectObservation(
  observation: ScreenObservation,
): ObservationProjection {
  const focusedElement = observation.focusedElement
    ? definedEntries({
        role: observation.focusedElement.role,
        subrole: observation.focusedElement.subrole,
        title: observation.focusedElement.title,
        value: observation.focusedElement.value,
        identifier: observation.focusedElement.identifier,
        description: observation.focusedElement.description,
        focused: observation.focusedElement.focused,
        enabled: observation.focusedElement.enabled,
        selected: observation.focusedElement.selected,
      })
    : undefined;
  return definedEntries({
    type: "observation" as const,
    sourceId: `observation:${observation.id}`,
    occurredAt: observation.occurredAt,
    capturedAt: observation.capturedAt,
    application: definedEntries({
      name: observation.window.applicationName,
      bundleIdentifier: observation.window.bundleIdentifier,
    }),
    windowTitle: observation.window.title,
    url: observation.url,
    focusedElement,
    visibleText: observation.visibleText,
  });
}

function compactToolResult(output: string) {
  const normalized = output.replace(/\r\n/g, "\n").trim();
  if (normalized.length <= TOOL_RESULT_MAX_CHARACTERS) return normalized;
  const marker = "\n…[truncated]…\n";
  let headEnd = 1_400;
  const tailLength = TOOL_RESULT_MAX_CHARACTERS - headEnd - marker.length;
  let tailStart = normalized.length - tailLength;
  if (/^[\uD800-\uDBFF]$/u.test(normalized[headEnd - 1] ?? "") &&
      /^[\uDC00-\uDFFF]$/u.test(normalized[headEnd] ?? "")) {
    headEnd -= 1;
  }
  if (/^[\uD800-\uDBFF]$/u.test(normalized[tailStart - 1] ?? "") &&
      /^[\uDC00-\uDFFF]$/u.test(normalized[tailStart] ?? "")) {
    tailStart += 1;
  }
  return `${normalized.slice(0, headEnd)}${marker}${normalized.slice(tailStart)}`;
}

export function projectTurnBatch(
  sessionId: string,
  sources: readonly ActivitySource[],
): TurnBatchProjection {
  return {
    type: "turn_batch",
    sessionId,
    turns: sources.map(({ sourceId, occurredAt, turn, agentRuns }) => ({
      sourceId,
      turnId: turn.id,
      occurredAt,
      startedAt: turn.startedAt,
      finishedAt: turn.finishedAt,
      status: turn.status,
      user: turn.user,
      assistant: turn.assistant,
      agentRuns: agentRuns.map((run) => {
        if (run.turnId !== turn.id) {
          throw new Error("Agent Run must reference the projected Turn");
        }
        return definedEntries({
          runId: run.id,
          status: run.status,
          startedAt: run.startedAt,
          finishedAt: run.finishedAt,
          tools: run.steps.flatMap((step) => step.toolResults.map((tool) => ({
            name: tool.name,
            status: tool.status,
            result: compactToolResult(tool.output),
          }))),
        });
      }),
    })),
  };
}

function object(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(message);
  }
  return value as Record<string, unknown>;
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  message: string,
) {
  const allowedKeys = new Set(allowed);
  const unexpected = Object.keys(value).find((key) => !allowedKeys.has(key));
  if (unexpected) throw new Error(`${message}: unexpected field ${unexpected}`);
}

function requiredString(value: unknown, message: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(message);
  return value.trim();
}

function optionalString(value: unknown, message: string) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error(message);
  const normalized = value.trim();
  return normalized || undefined;
}

function stringArray(value: unknown, message: string, allowEmpty = true) {
  if (!Array.isArray(value) ||
      (!allowEmpty && value.length === 0) ||
      !value.every((entry) => typeof entry === "string" && entry.trim())) {
    throw new Error(message);
  }
  return value.map((entry) => (entry as string).trim());
}

function scopeHints(value: unknown): MemoryScopeHint[] {
  if (!Array.isArray(value)) throw new Error("Invalid Activity scope_hints");
  return value.map((entry) => {
    const hint = object(entry, "Invalid Activity scope hint");
    assertOnlyKeys(hint, ["type", "key", "label"], "Invalid Activity scope hint");
    if (typeof hint.type !== "string" || !SCOPE_TYPES.has(hint.type)) {
      throw new Error(`Activity returned unsupported memory scope ${String(hint.type)}`);
    }
    const key = optionalString(hint.key, "Invalid Activity scope key");
    const label = optionalString(hint.label, "Invalid Activity scope label");
    if (hint.type !== "global" && !key) {
      throw new Error(`Activity memory scope ${hint.type} requires a key`);
    }
    return definedEntries({ type: hint.type, key, label }) as MemoryScopeHint;
  });
}

function activityOutput(value: unknown): ActivityRecordOutput {
  const activity = object(value, "Invalid Activity activity");
  assertOnlyKeys(activity, [
    "summary",
    "source_ids",
    "application",
    "window_title",
    "entities",
    "verbatim_evidence",
    "scope_hints",
  ], "Invalid Activity activity");
  const application = optionalString(
    activity.application,
    "Invalid Activity activity application",
  );
  const windowTitle = optionalString(
    activity.window_title,
    "Invalid Activity activity window_title",
  );
  return definedEntries({
    summary: requiredString(activity.summary, "Invalid Activity activity summary"),
    sourceIds: stringArray(
      activity.source_ids,
      "Invalid Activity activity source_ids",
      false,
    ),
    application,
    windowTitle,
    entities: stringArray(activity.entities, "Invalid Activity activity entities"),
    verbatimEvidence: stringArray(
      activity.verbatim_evidence,
      "Invalid Activity activity verbatim_evidence",
    ),
    scopeHints: scopeHints(activity.scope_hints),
  });
}

export function parseActivityOutput(
  output: string,
  expectedSourceIds: ReadonlySet<string>,
  expectedStatuses?: ReadonlyMap<string, TerminalTurnStatus | "observed">,
): ActivityOutput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error("Model returned invalid Activity JSON");
  }
  const root = object(parsed, "Model returned invalid Activity JSON");
  assertOnlyKeys(root, [
    "activities",
    "source_summary",
    "raw_memory",
    "scope_hints",
  ], "Invalid Activity output");
  if (!Array.isArray(root.activities) || root.activities.length === 0) {
    throw new Error("Activity output must contain activities");
  }
  const activities = root.activities.map(activityOutput);
  const covered = new Set<string>();
  for (const activity of activities) {
    const statuses = new Set<TerminalTurnStatus | "observed">();
    for (const sourceId of activity.sourceIds) {
      if (!expectedSourceIds.has(sourceId)) {
        throw new Error(`Activity returned unknown source ${sourceId}`);
      }
      if (covered.has(sourceId)) {
        throw new Error(`Activity returned source ${sourceId} more than once`);
      }
      covered.add(sourceId);
      if (expectedStatuses) {
        const status = expectedStatuses.get(sourceId);
        if (!status) throw new Error(`Missing expected status for source ${sourceId}`);
        statuses.add(status);
      }
    }
    if (statuses.size > 1) {
      throw new Error("One activity cannot combine sources with different statuses");
    }
  }
  for (const sourceId of expectedSourceIds) {
    if (!covered.has(sourceId)) {
      throw new Error(`Activity output is missing source ${sourceId}`);
    }
  }
  const rawMemory = optionalString(
    root.raw_memory,
    "Invalid Activity raw_memory",
  ) ?? null;
  return {
    activities,
    sourceSummary: requiredString(
      root.source_summary,
      "Invalid Activity source_summary",
    ),
    rawMemory,
    scopeHints: scopeHints(root.scope_hints),
  };
}
