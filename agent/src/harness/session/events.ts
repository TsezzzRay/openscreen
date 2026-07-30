import type { ModelOutputItem } from "../../types.js";
import type {
  AgentRun,
  AgentRunStep,
  ChatImage,
  StoredSession,
  Turn,
  VisibleTurn,
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
  startedAt: string;
  agentRun?: boolean;
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
  turn: Turn & { id: string };
} | {
  type: "turn_failed";
  turnId: string;
  message: string;
  includeInContext?: boolean;
} | {
  type: "turn_cancelled";
  turnId: string;
} | {
  type: "agent_step_completed";
  turnId: string;
  step: number;
  responseId?: string;
  outputItems: ModelOutputItem[];
  totalTokens?: number;
} | {
  type: "tool_result_recorded";
  turnId: string;
  step: number;
  callId: string;
  name: string;
  output: string;
  status: "completed" | "failed";
} | {
  type: "context_compacted";
  summary: string;
  firstKeptTurnIndex: number;
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
    (image.source === "system_capture" || image.source === "user_upload") &&
    typeof image.path === "string" && image.path.length > 0
  ));
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

function isTurn(value: unknown): value is Turn & { id: string } {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    "id",
    "user",
    "assistant",
    "reasoning",
    "images",
    "status",
    "outputItems",
  ])) return false;
  return typeof value.id === "string" && value.id.length > 0 &&
    typeof value.user === "string" &&
    typeof value.assistant === "string" &&
    (value.images === undefined || isChatImages(value.images)) &&
    (value.status === undefined || value.status === "completed" ||
      value.status === "failed" || value.status === "cancelled") &&
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
          !hasOnlyKeys(turn, ["id", "user", "images", "startedAt", "agentRun"]) ||
          typeof turn.user !== "string" ||
          ("images" in turn && turn.images !== undefined && !isChatImages(turn.images)) ||
          ("agentRun" in turn && turn.agentRun !== undefined &&
            typeof turn.agentRun !== "boolean") ||
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
      if (isTurn(value.turn)) return value as SessionEvent;
      break;
    case "turn_failed":
      if (typeof value.turnId === "string" && value.turnId &&
          typeof value.message === "string" &&
          (!("includeInContext" in value) || value.includeInContext === undefined ||
            typeof value.includeInContext === "boolean")) {
        return value as SessionEvent;
      }
      break;
    case "turn_cancelled":
      if (typeof value.turnId === "string" && value.turnId) return value as SessionEvent;
      break;
    case "agent_step_completed":
      if (typeof value.turnId === "string" && value.turnId &&
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
      if (typeof value.turnId === "string" && value.turnId &&
          Number.isInteger(value.step) && (value.step as number) > 0 &&
          typeof value.callId === "string" && value.callId &&
          typeof value.name === "string" && value.name &&
          typeof value.output === "string" &&
          (value.status === "completed" || value.status === "failed")) {
        return value as SessionEvent;
      }
      break;
    case "context_compacted":
      if (typeof value.summary === "string" && Number.isInteger(value.firstKeptTurnIndex) &&
          (value.firstKeptTurnIndex as number) >= 0) {
        return value as SessionEvent;
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
  const visibleTurns: VisibleTurn[] = [];
  const visibleIndexes = new Map<string, number>();
  const pending = new Map<string, VisibleTurn>();
  const pendingTurns = new Map<string, StartedTurn>();
  const agentRuns: AgentRun[] = [];
  const agentRunIndexes = new Map<string, number>();
  let summary: string | undefined;
  let firstKeptTurnIndex = 0;

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
        if (event.turn.agentRun) {
          agentRunIndexes.set(event.turn.id, agentRuns.length);
          agentRuns.push({
            id: event.turn.id,
            status: "interrupted",
            startedAt: event.turn.startedAt,
            steps: [],
          });
        }
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
        if (visibleIndex === undefined || !pending.has(event.turn.id)) {
          throw new Error(`Unknown turn at line ${index + 1}`);
        }
        const runIndex = agentRunIndexes.get(event.turn.id);
        const run = runIndex === undefined ? undefined : agentRuns[runIndex];
        if (run) run.status = "completed";
        const outputItems = run?.steps.flatMap((step) => [
          ...step.outputItems,
          ...step.toolResults.map(({ callId, output }) => ({
            type: "function_call_output" as const,
            call_id: callId,
            output,
          })),
        ]);
        turns.push(event.turn.outputItems || !outputItems?.length
          ? event.turn
          : { ...event.turn, outputItems });
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
        const runIndex = agentRunIndexes.get(event.turnId);
        if (runIndex !== undefined) agentRuns[runIndex]!.status = "failed";
        if (event.includeInContext) {
          turns.push({
            id: started.id,
            user: started.user,
            assistant: visible.assistant,
            reasoning: visible.reasoning,
            ...(started.images ? { images: started.images } : {}),
            status: "failed",
          });
        }
        pending.delete(event.turnId);
        pendingTurns.delete(event.turnId);
        break;
      }
      case "turn_cancelled": {
        const visible = pending.get(event.turnId);
        const started = pendingTurns.get(event.turnId);
        if (!visible || !started) throw new Error(`Unknown turn at line ${index + 1}`);
        visible.status = "cancelled";
        const runIndex = agentRunIndexes.get(event.turnId);
        if (runIndex !== undefined) agentRuns[runIndex]!.status = "cancelled";
        turns.push({
          id: started.id,
          user: started.user,
          assistant: visible.assistant,
          reasoning: visible.reasoning,
          ...(started.images ? { images: started.images } : {}),
          status: "cancelled",
        });
        pending.delete(event.turnId);
        pendingTurns.delete(event.turnId);
        break;
      }
      case "agent_step_completed": {
        const runIndex = agentRunIndexes.get(event.turnId);
        const run = runIndex === undefined ? undefined : agentRuns[runIndex];
        if (!run || !pending.has(event.turnId) || event.step !== run.steps.length + 1) {
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
        const runIndex = agentRunIndexes.get(event.turnId);
        const run = runIndex === undefined ? undefined : agentRuns[runIndex];
        const step = run?.steps[event.step - 1];
        const call = step?.outputItems.find(
          (item) => item.type === "function_call" &&
            item.call_id === event.callId && item.name === event.name,
        );
        if (!run || !pending.has(event.turnId) || !step || !call ||
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
      case "context_compacted":
        if (event.firstKeptTurnIndex > turns.length) {
          throw new Error(`Invalid compaction event at line ${index + 1}`);
        }
        summary = event.summary;
        firstKeptTurnIndex = event.firstKeptTurnIndex;
        break;
    }
  }

  return {
    id: header.id,
    title: header.title,
    createdAt: header.createdAt,
    updatedAt,
    turns,
    visibleTurns,
    agentRuns,
    summary,
    firstKeptTurnIndex,
  };
}
