import { prepareCompaction, DEFAULT_COMPACTION_SETTINGS } from "@earendil-works/pi-agent-core";
import type { Model, Message, AssistantMessage } from "@earendil-works/pi-ai";
import { PiAgentService } from "../../src/agent/pi/service.js";
import { PiSessionRuntime } from "../../src/agent/pi/session-runtime.js";
import type { Task } from "../dataset.js";
import { executeAgentSession } from "./agent.js";
import type { WorkloadEnvironment } from "./environment.js";

export function compactionHistory(history: NonNullable<Task["input"]["history"]>, model: Model<string>): Message[] {
  const messages: Message[] = [];
  for (const [index, item] of history.entries()) {
    const timestamp = Date.parse("2026-09-01T09:00:00Z") + index;
    if (item.role === "user") { messages.push({ role: "user", content: item.text, timestamp }); continue; }
    const assistant: AssistantMessage = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, timestamp, stopReason: item.role === "tool" ? "toolUse" : "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    if (item.role === "assistant") assistant.content = [{ type: "text", text: item.text }];
    else assistant.content = [{ type: "toolCall", id: `history-${index}`, name: item.name, arguments: item.arguments }];
    messages.push(assistant);
    if (item.role === "tool") messages.push({ role: "toolResult", toolCallId: `history-${index}`, toolName: item.name, content: [{ type: "text", text: item.text }], isError: false, timestamp });
  }
  return messages;
}

export async function executeCompactionWorkload(environment: WorkloadEnvironment) {
  const { task, model, options, emit } = environment;
  const agent = new PiAgentService(options);
  const runtime = new PiSessionRuntime(options);
  const created = await runtime.createEntry();
  const sessionId = created.id;
  const history = compactionHistory(task.input.history!, model);
  for (const message of history) await created.entry.session.appendMessage(message);
  emit({ type: "session-before", entries: await created.entry.session.getEntries() });
  const preparation = prepareCompaction(await created.entry.session.getBranch(), DEFAULT_COMPACTION_SETTINGS);
  if (!preparation.ok || !preparation.value) throw new Error("Compaction fixture did not produce a summary boundary");
  const summaryInput = JSON.stringify(preparation.value.messagesToSummarize);
  const missingMarkers = (task.input.summaryMustInclude ?? []).filter(marker => !summaryInput.includes(marker));
  if (summaryInput.length < 50_000 || missingMarkers.length) {
    throw new Error(`Compaction fixture produced insufficient summary input${missingMarkers.length ? `; missing: ${missingMarkers.join(", ")}` : ""}`);
  }
  emit({ type: "compaction-boundary", summarizedMessages: preparation.value.messagesToSummarize.length, summaryInputCharacters: summaryInput.length, firstKeptEntryId: preparation.value.firstKeptEntryId });
  // Seed the fixture through the Session repository, but perform the
  // operation through the production service (including its local hooks).
  const compression = await agent.compact(sessionId);
  emit({ type: "compaction", result: compression });
  return executeAgentSession(environment, agent, sessionId, compression);
}
