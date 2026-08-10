import type {
  ModelOutputItem,
  TurnScreenContext,
} from "../../types.js";
import type {
  AgentRun,
  AgentRunStep,
  ChatImage,
  ConversationSummary,
  StoredSession,
  Turn,
  VisibleTurn,
  RecordedTurn,
} from "./types.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type SessionHeader = {
  type: "session";
  id: string;
  title: string;
  createdAt: string;
};

export type StartedTurn = {
  id: string;
  user: string;
  images?: ChatImage[];
  screenContext?: TurnScreenContext;
  startedAt: string;
};

export type StartedAgentRun = {
  id: string;
  turnId: string;
  startedAt: string;
};

export type SessionEvent = {
  type: "turn_started";
  turn: StartedTurn;
} | {
  type: "reasoning_delta" | "answer_delta";
  turnId: string;
  delta: string;
} | {
  type: "turn_completed";
  turn: Turn;
} | {
  type: "turn_failed";
  turnId: string;
  finishedAt: string;
  message: string;
  includeInContext?: boolean;
} | {
  type: "turn_cancelled";
  turnId: string;
  finishedAt: string;
} | {
  type: "agent_run_started";
  run: StartedAgentRun;
} | {
  type: "agent_step_completed";
  runId: string;
  step: number;
  responseId?: string;
  outputItems: ModelOutputItem[];
  totalTokens?: number;
} | {
  type: "tool_call_started";
  runId: string;
  step: number;
  callId: string;
  name: string;
  arguments: string;
  startedAt: string;
} | {
  type: "tool_call_finished";
  runId: string;
  step: number;
  callId: string;
  name: string;
  output: string;
  status: "completed" | "failed";
  finishedAt: string;
  details?: unknown;
} | {
  type: "tool_result_recorded";
  runId: string;
  step: number;
  callId: string;
  name: string;
  output: string;
  status: "completed" | "failed";
} | {
  type: "agent_run_finished";
  runId: string;
  status: "completed" | "failed" | "cancelled";
  finishedAt: string;
} | {
  type: "context_compacted";
  summary: ConversationSummary;
};

export function isSessionId(value: string) {
  return UUID_PATTERN.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
) {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isChatImages(value: unknown): value is ChatImage[] {
  return Array.isArray(value) && value.every((image) => (
    isRecord(image) && typeof image.id === "string" && image.id.length > 0 &&
    image.source === "user_upload" &&
    typeof image.path === "string" && image.path.length > 0
  ));
}

function isTurnScreenContext(value: unknown): value is TurnScreenContext {
  if (!isRecord(value) || !hasOnlyKeys(value, ["ref", "accessibility"])) {
    return false;
  }
  const ref = value.ref;
  if (!isRecord(ref) || !hasOnlyKeys(ref, [
    "captureId",
    "observationId",
    "intentRevision",
    "artifactRevision",
    "completedRevision",
    "intentContentEpoch",
    "artifactContentEpoch",
    "completedContentEpoch",
    "startedAt",
    "capturedAt",
    "status",
    "target",
    "image",
  ])) return false;
  const target = ref.target;
  if (!isRecord(target) ||
      !hasOnlyKeys(target, ["processIdentifier", "windowIdentifier"]) ||
      !Number.isInteger(target.processIdentifier) ||
      !Number.isInteger(target.windowIdentifier)) return false;
  const image = ref.image;
  if (image !== undefined && (
    !isRecord(image) ||
    !hasOnlyKeys(image, ["path", "mimeType", "width", "height"]) ||
    typeof image.path !== "string" || image.path.length === 0 ||
    image.mimeType !== "image/jpeg" ||
    !Number.isInteger(image.width) || (image.width as number) <= 0 ||
    !Number.isInteger(image.height) || (image.height as number) <= 0
  )) return false;
  if (
    typeof ref.captureId !== "string" || ref.captureId.length === 0 ||
    (ref.observationId !== undefined &&
      (typeof ref.observationId !== "string" || ref.observationId.length === 0)) ||
    !Number.isInteger(ref.intentRevision) ||
    (ref.intentRevision as number) <= 0 ||
    !Number.isInteger(ref.artifactRevision) ||
    (ref.artifactRevision as number) <= 0 ||
    (ref.intentRevision as number) < (ref.artifactRevision as number) ||
    !Number.isInteger(ref.completedRevision) ||
    (ref.completedRevision as number) < (ref.artifactRevision as number) ||
    !Number.isInteger(ref.intentContentEpoch) ||
    (ref.intentContentEpoch as number) < 0 ||
    !Number.isInteger(ref.artifactContentEpoch) ||
    (ref.artifactContentEpoch as number) < 0 ||
    (ref.intentContentEpoch as number) <
      (ref.artifactContentEpoch as number) ||
    !Number.isInteger(ref.completedContentEpoch) ||
    (ref.completedContentEpoch as number) < (ref.artifactContentEpoch as number) ||
    (ref.startedAt !== undefined && (
      typeof ref.startedAt !== "string" ||
      Number.isNaN(Date.parse(ref.startedAt))
    )) ||
    typeof ref.capturedAt !== "string" ||
    Number.isNaN(Date.parse(ref.capturedAt)) ||
    !["complete", "screenshot_only", "ax_only", "failed"].includes(
      String(ref.status),
    )
  ) return false;
  const accessibility = value.accessibility;
  if (accessibility === undefined) return true;
  if (!isRecord(accessibility) || !hasOnlyKeys(accessibility, [
    "captureId",
    "application",
    "windowTitle",
    "url",
    "focusedElement",
    "elements",
    "visibleText",
  ])) return false;
  const focused = accessibility.focusedElement;
  if (focused !== undefined && (
    !isRecord(focused) ||
    !hasOnlyKeys(focused, ["role", "title", "value"]) ||
    typeof focused.role !== "string" || focused.role.length === 0 ||
    (focused.title !== undefined && typeof focused.title !== "string") ||
    (focused.value !== undefined && typeof focused.value !== "string")
  )) return false;
  const elements = accessibility.elements;
  if (elements !== undefined && (
    !Array.isArray(elements) ||
    elements.length > 64 ||
    !elements.every((element) =>
      isRecord(element) &&
      hasOnlyKeys(element, [
        "role",
        "name",
        "value",
        "enabled",
        "selected",
      ]) &&
      typeof element.role === "string" &&
      element.role.length > 0 &&
      (element.name === undefined || typeof element.name === "string") &&
      (element.value === undefined || typeof element.value === "string") &&
      (element.enabled === undefined || typeof element.enabled === "boolean") &&
      (element.selected === undefined || typeof element.selected === "boolean")
    )
  )) return false;
  return accessibility.captureId === ref.captureId &&
    typeof accessibility.application === "string" &&
    accessibility.application.length > 0 &&
    (accessibility.windowTitle === undefined ||
      typeof accessibility.windowTitle === "string") &&
    (accessibility.url === undefined || typeof accessibility.url === "string") &&
    (accessibility.visibleText === undefined ||
      typeof accessibility.visibleText === "string") &&
    JSON.stringify(accessibility).length <= 10_000;
}

function isModelOutputItems(value: unknown): value is ModelOutputItem[] {
  return Array.isArray(value) && value.every((item) => {
    if (!isRecord(item) || typeof item.type !== "string") return false;
    if (item.type === "reasoning") {
      return typeof item.id === "string" && item.id.length > 0 &&
        Array.isArray(item.summary) &&
        (!("content" in item) || item.content === undefined || Array.isArray(item.content));
    }
    if (item.type === "message") {
      return typeof item.id === "string" && item.id.length > 0 &&
        item.role === "assistant" &&
        (item.status === "in_progress" || item.status === "completed" ||
          item.status === "incomplete") &&
        Array.isArray(item.content);
    }
    return item.type === "function_call" &&
      typeof item.call_id === "string" && item.call_id.length > 0 &&
      typeof item.name === "string" && item.name.length > 0 &&
      typeof item.arguments === "string";
  });
}

function visibleImages(turn: { images?: ChatImage[] }) {
  const images = (turn.images ?? []).filter((image) => image.source === "user_upload");
  return images.length > 0 ? { images } : {};
}

function isTurn(value: unknown): value is Turn {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    "id",
    "user",
    "assistant",
    "reasoning",
    "images",
    "screenContext",
    "status",
    "startedAt",
    "finishedAt",
    "outputItems",
  ])) return false;
  return typeof value.id === "string" && value.id.length > 0 &&
    typeof value.user === "string" &&
    typeof value.assistant === "string" &&
    (value.images === undefined || isChatImages(value.images)) &&
    (value.screenContext === undefined ||
      isTurnScreenContext(value.screenContext)) &&
    (value.status === "completed" || value.status === "failed" ||
      value.status === "cancelled") &&
    typeof value.startedAt === "string" &&
    typeof value.finishedAt === "string" &&
    (value.reasoning === undefined || typeof value.reasoning === "string") &&
    (value.outputItems === undefined || Array.isArray(value.outputItems));
}

export function parseSessionHeader(line: string): SessionHeader {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error("Invalid session metadata");
  }
  if (!isRecord(value) || value.type !== "session" ||
      typeof value.id !== "string" || !isSessionId(value.id) ||
      typeof value.title !== "string" || typeof value.createdAt !== "string") {
    throw new Error("Invalid session metadata");
  }
  return value as SessionHeader;
}

function parseSessionEvent(line: string, lineNumber: number): SessionEvent {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error(`Invalid session event at line ${lineNumber}`);
  }
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new Error(`Invalid session event at line ${lineNumber}`);
  }
  switch (value.type) {
    case "turn_started": {
      const turn = value.turn;
      if (!isRecord(turn) || typeof turn.id !== "string" || !turn.id ||
          !hasOnlyKeys(turn, ["id", "user", "images", "screenContext", "startedAt"]) ||
          typeof turn.user !== "string" ||
          ("images" in turn && turn.images !== undefined && !isChatImages(turn.images)) ||
          ("screenContext" in turn && turn.screenContext !== undefined &&
            !isTurnScreenContext(turn.screenContext)) ||
          typeof turn.startedAt !== "string") break;
      return value as SessionEvent;
    }
    case "reasoning_delta":
    case "answer_delta":
      if (typeof value.turnId === "string" && value.turnId && typeof value.delta === "string") {
        return value as SessionEvent;
      }
      break;
    case "turn_completed":
      if (isTurn(value.turn) && value.turn.status === "completed") {
        return value as SessionEvent;
      }
      break;
    case "turn_failed":
      if (typeof value.turnId === "string" && value.turnId &&
          typeof value.finishedAt === "string" &&
          typeof value.message === "string" &&
          (!("includeInContext" in value) || value.includeInContext === undefined ||
            typeof value.includeInContext === "boolean")) {
        return value as SessionEvent;
      }
      break;
    case "turn_cancelled":
      if (typeof value.turnId === "string" && value.turnId &&
          typeof value.finishedAt === "string") return value as SessionEvent;
      break;
    case "agent_run_started": {
      const run = value.run;
      if (isRecord(run) && hasOnlyKeys(run, ["id", "turnId", "startedAt"]) &&
          typeof run.id === "string" && run.id &&
          typeof run.turnId === "string" && run.turnId &&
          typeof run.startedAt === "string") {
        return value as SessionEvent;
      }
      break;
    }
    case "agent_step_completed":
      if (typeof value.runId === "string" && value.runId &&
          Number.isInteger(value.step) && (value.step as number) > 0 &&
          (!("responseId" in value) || value.responseId === undefined ||
            typeof value.responseId === "string") &&
          isModelOutputItems(value.outputItems) &&
          (!("totalTokens" in value) || value.totalTokens === undefined ||
            (Number.isFinite(value.totalTokens) && (value.totalTokens as number) >= 0))) {
        return value as SessionEvent;
      }
      break;
    case "tool_result_recorded":
      if (typeof value.runId === "string" && value.runId &&
          Number.isInteger(value.step) && (value.step as number) > 0 &&
          typeof value.callId === "string" && value.callId &&
          typeof value.name === "string" && value.name &&
          typeof value.output === "string" &&
          (value.status === "completed" || value.status === "failed")) {
        return value as SessionEvent;
      }
      break;
    case "tool_call_started":
      if (typeof value.runId === "string" && value.runId &&
          Number.isInteger(value.step) && (value.step as number) > 0 &&
          typeof value.callId === "string" && value.callId &&
          typeof value.name === "string" && value.name &&
          typeof value.arguments === "string" &&
          typeof value.startedAt === "string") {
        return value as SessionEvent;
      }
      break;
    case "tool_call_finished":
      if (typeof value.runId === "string" && value.runId &&
          Number.isInteger(value.step) && (value.step as number) > 0 &&
          typeof value.callId === "string" && value.callId &&
          typeof value.name === "string" && value.name &&
          typeof value.output === "string" &&
          (value.status === "completed" || value.status === "failed") &&
          typeof value.finishedAt === "string") {
        return value as SessionEvent;
      }
      break;
    case "agent_run_finished":
      if (typeof value.runId === "string" && value.runId &&
          (value.status === "completed" || value.status === "failed" ||
            value.status === "cancelled") &&
          typeof value.finishedAt === "string") {
        return value as SessionEvent;
      }
      break;
    case "context_compacted": {
      const summary = value.summary;
      if (isRecord(summary) &&
          hasOnlyKeys(summary, ["content", "createdAt", "firstKeptTurnIndex"]) &&
          typeof summary.content === "string" && summary.content &&
          typeof summary.createdAt === "string" &&
          Number.isInteger(summary.firstKeptTurnIndex) &&
          (summary.firstKeptTurnIndex as number) >= 0) {
        return value as SessionEvent;
      }
      break;
    }
  }
  throw new Error(`Invalid session event at line ${lineNumber}`);
}

export function replaySession(
  lines: string[],
  expectedId: string,
  updatedAt: string,
): StoredSession {
  if (lines.length === 0) throw new Error("Invalid session metadata");
  const header = parseSessionHeader(lines[0]!);
  if (header.id !== expectedId) throw new Error("Session ID does not match filename");

  const turns: Turn[] = [];
  const recordedTurns: RecordedTurn[] = [];
  const visibleTurns: VisibleTurn[] = [];
  const visibleIndexes = new Map<string, number>();
  const pending = new Map<string, VisibleTurn>();
  const pendingTurns = new Map<string, StartedTurn>();
  const agentRuns: AgentRun[] = [];
  const agentRunIndexes = new Map<string, number>();
  let conversationSummary: ConversationSummary | undefined;

  for (let index = 1; index < lines.length; index += 1) {
    const event = parseSessionEvent(lines[index]!, index + 1);
    switch (event.type) {
      case "turn_started": {
        if (visibleIndexes.has(event.turn.id)) {
          throw new Error(`Duplicate turn at line ${index + 1}`);
        }
        const visible: VisibleTurn = {
          id: event.turn.id,
          user: event.turn.user,
          assistant: "",
          reasoning: "",
          status: "interrupted",
          ...visibleImages(event.turn),
        };
        visibleIndexes.set(event.turn.id, visibleTurns.length);
        visibleTurns.push(visible);
        pending.set(event.turn.id, visible);
        pendingTurns.set(event.turn.id, event.turn);
        break;
      }
      case "reasoning_delta":
      case "answer_delta": {
        const visible = pending.get(event.turnId);
        if (!visible) throw new Error(`Unknown turn at line ${index + 1}`);
        if (event.type === "reasoning_delta") {
          visible.reasoning = (visible.reasoning ?? "") + event.delta;
        } else {
          visible.assistant += event.delta;
        }
        break;
      }
      case "turn_completed": {
        const visibleIndex = visibleIndexes.get(event.turn.id);
        const started = pendingTurns.get(event.turn.id);
        if (visibleIndex === undefined || !pending.has(event.turn.id) || !started) {
          throw new Error(`Unknown turn at line ${index + 1}`);
        }
        if (event.turn.user !== started.user ||
            event.turn.startedAt !== started.startedAt ||
            JSON.stringify(event.turn.images) !== JSON.stringify(started.images) ||
            JSON.stringify(event.turn.screenContext) !==
              JSON.stringify(started.screenContext)) {
          throw new Error(`Turn start mismatch at line ${index + 1}`);
        }
        const runs = agentRuns.filter(({ turnId }) => turnId === event.turn.id);
        if (runs.some(({ status }) => status === "interrupted")) {
          throw new Error(`Active Agent Run at line ${index + 1}`);
        }
        const outputItems = runs.flatMap(({ steps }) => steps.flatMap((step) => [
          ...step.outputItems,
          ...step.outputItems.flatMap((item) => {
            if (item.type !== "function_call") return [];
            const result = step.toolResults.find(({ callId }) => callId === item.call_id);
            return result
              ? [{
                  type: "function_call_output" as const,
                  call_id: result.callId,
                  output: result.output,
                }]
              : [];
          }),
        ]));
        turns.push(event.turn.outputItems || !outputItems?.length
          ? event.turn
          : { ...event.turn, outputItems });
        recordedTurns.push(event.turn);
        visibleTurns[visibleIndex] = {
          id: event.turn.id,
          user: event.turn.user,
          assistant: event.turn.assistant,
          reasoning: event.turn.reasoning,
          status: "completed",
          ...visibleImages(event.turn),
        };
        pending.delete(event.turn.id);
        pendingTurns.delete(event.turn.id);
        break;
      }
      case "turn_failed": {
        const visible = pending.get(event.turnId);
        const started = pendingTurns.get(event.turnId);
        if (!visible || !started) throw new Error(`Unknown turn at line ${index + 1}`);
        visible.status = "failed";
        visible.error = event.message;
        if (agentRuns.some(({ turnId, status }) =>
          turnId === event.turnId && status === "interrupted")) {
          throw new Error(`Active Agent Run at line ${index + 1}`);
        }
        if (event.includeInContext) {
          turns.push({
            id: started.id,
            user: started.user,
            assistant: visible.assistant,
            reasoning: visible.reasoning,
            ...(started.images ? { images: started.images } : {}),
            ...(started.screenContext
              ? { screenContext: started.screenContext }
              : {}),
            status: "failed",
            startedAt: started.startedAt,
            finishedAt: event.finishedAt,
          });
        }
        recordedTurns.push({
          id: started.id,
          user: started.user,
          assistant: visible.assistant,
          reasoning: visible.reasoning,
          ...(started.images ? { images: started.images } : {}),
          ...(started.screenContext
            ? { screenContext: started.screenContext }
            : {}),
          status: "failed",
          startedAt: started.startedAt,
          finishedAt: event.finishedAt,
        });
        pending.delete(event.turnId);
        pendingTurns.delete(event.turnId);
        break;
      }
      case "turn_cancelled": {
        const visible = pending.get(event.turnId);
        const started = pendingTurns.get(event.turnId);
        if (!visible || !started) throw new Error(`Unknown turn at line ${index + 1}`);
        visible.status = "cancelled";
        if (agentRuns.some(({ turnId, status }) =>
          turnId === event.turnId && status === "interrupted")) {
          throw new Error(`Active Agent Run at line ${index + 1}`);
        }
        turns.push({
          id: started.id,
          user: started.user,
          assistant: visible.assistant,
          reasoning: visible.reasoning,
          ...(started.images ? { images: started.images } : {}),
          ...(started.screenContext
            ? { screenContext: started.screenContext }
            : {}),
          status: "cancelled",
          startedAt: started.startedAt,
          finishedAt: event.finishedAt,
        });
        recordedTurns.push({
          id: started.id,
          user: started.user,
          assistant: visible.assistant,
          reasoning: visible.reasoning,
          ...(started.images ? { images: started.images } : {}),
          ...(started.screenContext
            ? { screenContext: started.screenContext }
            : {}),
          status: "cancelled",
          startedAt: started.startedAt,
          finishedAt: event.finishedAt,
        });
        pending.delete(event.turnId);
        pendingTurns.delete(event.turnId);
        break;
      }
      case "agent_run_started": {
        if (!pending.has(event.run.turnId)) {
          throw new Error(`Unknown turn at line ${index + 1}`);
        }
        if (agentRunIndexes.has(event.run.id)) {
          throw new Error(`Duplicate Agent Run at line ${index + 1}`);
        }
        agentRunIndexes.set(event.run.id, agentRuns.length);
        agentRuns.push({
          id: event.run.id,
          turnId: event.run.turnId,
          status: "interrupted",
          startedAt: event.run.startedAt,
          steps: [],
        });
        break;
      }
      case "agent_step_completed": {
        const runIndex = agentRunIndexes.get(event.runId);
        const run = runIndex === undefined ? undefined : agentRuns[runIndex];
        if (!run || !pending.has(run.turnId) || run.status !== "interrupted" ||
            event.step !== run.steps.length + 1) {
          throw new Error(`Invalid agent step at line ${index + 1}`);
        }
        const step: AgentRunStep = {
          step: event.step,
          ...(event.responseId ? { responseId: event.responseId } : {}),
          outputItems: event.outputItems,
          ...(event.totalTokens === undefined ? {} : { totalTokens: event.totalTokens }),
          toolResults: [],
        };
        run.steps.push(step);
        break;
      }
      case "tool_result_recorded": {
        const runIndex = agentRunIndexes.get(event.runId);
        const run = runIndex === undefined ? undefined : agentRuns[runIndex];
        const step = run?.steps[event.step - 1];
        const call = step?.outputItems.find(
          (item) => item.type === "function_call" &&
            item.call_id === event.callId && item.name === event.name,
        );
        if (!run || !pending.has(run.turnId) || run.status !== "interrupted" ||
            !step || !call ||
            step.toolResults.some(({ callId }) => callId === event.callId)) {
          throw new Error(`Invalid tool result at line ${index + 1}`);
        }
        step.toolResults.push({
          callId: event.callId,
          name: event.name,
          output: event.output,
          status: event.status,
        });
        break;
      }
      case "tool_call_started": {
        const runIndex = agentRunIndexes.get(event.runId);
        const run = runIndex === undefined ? undefined : agentRuns[runIndex];
        const step = run?.steps[event.step - 1];
        const call = step?.outputItems.find(
          (item) => item.type === "function_call" &&
            item.call_id === event.callId && item.name === event.name &&
            item.arguments === event.arguments,
        );
        if (!run || !pending.has(run.turnId) || run.status !== "interrupted" ||
            !step || !call ||
            step.toolResults.some(({ callId }) => callId === event.callId) ||
            step.toolCalls?.some(({ callId }) => callId === event.callId)) {
          throw new Error(`Invalid tool call at line ${index + 1}`);
        }
        step.toolCalls ??= [];
        step.toolCalls.push({
          callId: event.callId,
          name: event.name,
          arguments: event.arguments,
          status: "interrupted",
          startedAt: event.startedAt,
        });
        break;
      }
      case "tool_call_finished": {
        const runIndex = agentRunIndexes.get(event.runId);
        const run = runIndex === undefined ? undefined : agentRuns[runIndex];
        const step = run?.steps[event.step - 1];
        const call = step?.toolCalls?.find(
          (toolCall) => toolCall.callId === event.callId &&
            toolCall.name === event.name && toolCall.status === "interrupted",
        );
        if (!run || !pending.has(run.turnId) || run.status !== "interrupted" ||
            !step || !call ||
            step.toolResults.some(({ callId }) => callId === event.callId)) {
          throw new Error(`Invalid tool result at line ${index + 1}`);
        }
        call.status = event.status;
        call.finishedAt = event.finishedAt;
        call.output = event.output;
        if (event.details !== undefined) call.details = event.details;
        step.toolResults.push({
          callId: event.callId,
          name: event.name,
          output: event.output,
          status: event.status,
          ...(event.details === undefined ? {} : { details: event.details }),
        });
        break;
      }
      case "agent_run_finished": {
        const runIndex = agentRunIndexes.get(event.runId);
        const run = runIndex === undefined ? undefined : agentRuns[runIndex];
        if (!run || !pending.has(run.turnId) || run.status !== "interrupted") {
          throw new Error(`Invalid Agent Run finish at line ${index + 1}`);
        }
        run.status = event.status;
        run.finishedAt = event.finishedAt;
        break;
      }
      case "context_compacted":
        if (event.summary.firstKeptTurnIndex > turns.length) {
          throw new Error(`Invalid compaction event at line ${index + 1}`);
        }
        conversationSummary = event.summary;
        break;
    }
  }

  for (const [turnId, started] of pendingTurns) {
    const visible = pending.get(turnId);
    if (!visible) continue;
    recordedTurns.push({
      id: started.id,
      user: started.user,
      assistant: visible.assistant,
      reasoning: visible.reasoning,
      ...(started.images ? { images: started.images } : {}),
      ...(started.screenContext
        ? { screenContext: started.screenContext }
        : {}),
      status: "interrupted",
      startedAt: started.startedAt,
      finishedAt: new Date(Math.max(
        Date.parse(started.startedAt),
        Date.parse(updatedAt),
      )).toISOString(),
    });
  }

  return {
    id: header.id,
    title: header.title,
    createdAt: header.createdAt,
    updatedAt,
    turns,
    visibleTurns,
    recordedTurns,
    agentRuns,
    ...(conversationSummary ? { conversationSummary } : {}),
  };
}
