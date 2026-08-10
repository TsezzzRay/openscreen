import type { AgentTool, RegisteredAgentTool } from "../types.js";

export type ToolRegistrySnapshot = Readonly<{
  tools: readonly RegisteredAgentTool[];
  capabilityPrompt: string;
}>;

type RegistryState = {
  tools: readonly RegisteredAgentTool[];
  executors: ReadonlyMap<string, RegisteredAgentTool>;
};

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    deepFreeze((value as Record<PropertyKey, unknown>)[key], seen);
  }
  return Object.freeze(value);
}

function registeredTool(tool: AgentTool): RegisteredAgentTool {
  const definition = deepFreeze(structuredClone(tool.definition));
  const guidelines = tool.guidelines === undefined
    ? undefined
    : Object.freeze([...tool.guidelines]);
  return Object.freeze({
    definition,
    ...(tool.source === undefined ? {} : { source: tool.source }),
    ...(guidelines === undefined ? {} : { guidelines }),
    execute: tool.execute,
  });
}

function buildState(tools: readonly AgentTool[]): RegistryState {
  const executors = new Map<string, RegisteredAgentTool>();
  const registeredTools = tools.map(registeredTool);
  for (const tool of registeredTools) {
    const name = tool.definition.name;
    if (executors.has(name)) throw new Error(`Duplicate tool name: ${name}`);
    executors.set(name, tool);
  }
  return {
    tools: Object.freeze(registeredTools),
    executors,
  };
}

function validateActiveNames(
  names: readonly string[],
  executors: ReadonlyMap<string, RegisteredAgentTool>,
) {
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) throw new Error(`Duplicate active tool name: ${name}`);
    if (!executors.has(name)) throw new Error(`Unknown tool name: ${name}`);
    seen.add(name);
  }
}

function capabilityPrompt(tools: readonly RegisteredAgentTool[]) {
  if (tools.length === 0) return "No tools are currently available.";
  return [
    "Available tools:",
    ...tools.flatMap((tool) => {
      const lines = [
        `- ${tool.definition.name}: ${tool.definition.description ?? "No description."}`,
      ];
      if (tool.source) lines.push(`  Source: ${tool.source}`);
      for (const guideline of tool.guidelines ?? []) {
        lines.push(`  Guideline: ${guideline}`);
      }
      return lines;
    }),
  ].join("\n");
}

function makeSnapshot(
  state: RegistryState,
  activeToolNames: readonly string[],
): ToolRegistrySnapshot {
  const tools = Object.freeze(activeToolNames.map((name) => state.executors.get(name)!));
  return Object.freeze({
    tools,
    capabilityPrompt: capabilityPrompt(tools),
  });
}

export class ToolRegistry {
  private readonly snapshot: ToolRegistrySnapshot;

  constructor(tools: readonly AgentTool[], activeToolNames?: readonly string[]) {
    const state = buildState(tools);
    const names = activeToolNames ?? state.tools.map((tool) => tool.definition.name);
    validateActiveNames(names, state.executors);
    this.snapshot = makeSnapshot(state, names);
  }

  getSnapshot() {
    return this.snapshot;
  }
}
