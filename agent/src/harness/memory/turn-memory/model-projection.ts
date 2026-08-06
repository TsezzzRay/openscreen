import { boundedText } from "../shared/request-budget.js";
import type {
  TurnMemoryBatchProjection,
  TurnMemorySource,
} from "./types.js";

const TURN_TEXT_MAX_CHARACTERS = 12_000;
const TOOL_RESULT_MAX_CHARACTERS = 2_000;

function definedEntries<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as T;
}

function modelText(value: string, maxCharacters: number) {
  return boundedText(value.replace(/\r\n/g, "\n").trim(), maxCharacters).text;
}

export function projectTurnMemoryBatch(
  sessionId: string,
  sources: readonly TurnMemorySource[],
): TurnMemoryBatchProjection {
  return {
    type: "turn_memory_batch",
    sessionId,
    turns: sources.map(({ sourceId, occurredAt, turn, agentRuns }) => ({
      sourceId,
      turnId: turn.id,
      occurredAt,
      startedAt: turn.startedAt,
      finishedAt: turn.finishedAt,
      status: turn.status,
      user: modelText(turn.user, TURN_TEXT_MAX_CHARACTERS),
      assistant: modelText(turn.assistant, TURN_TEXT_MAX_CHARACTERS),
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
            result: modelText(tool.output, TOOL_RESULT_MAX_CHARACTERS),
          }))),
        });
      }),
    })),
  };
}
