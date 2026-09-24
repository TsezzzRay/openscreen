export function metrics(events: { event: Record<string, any> }[], durationMs: number | null) {
  let modelRequests = 0, toolCalls = 0, knownInputTokens = 0, knownOutputTokens = 0;
  let usageRecords = 0, knownCostUsd = 0, costRecords = 0;
  let directModelRequests = 0, memoryCycles = 0;
  const requestDurationsMs: number[] = [], memoryCycleDurationsMs: number[] = [];
  for (const { event } of events) {
    if (event.type === "model-start") directModelRequests++;
    if (["observation-start", "reflection-start"].includes(event.type)) memoryCycles++;
    if (typeof event.durationMs === "number" && Number.isFinite(event.durationMs)) {
      if (event.type === "model-end") requestDurationsMs.push(event.durationMs);
      if (["observation-end", "reflection-end"].includes(event.type)) memoryCycleDurationsMs.push(event.durationMs);
    }
    if (["model-start", "observation-start", "reflection-start"].includes(event.type)) modelRequests++;
    if (event.type === "agent-event" && event.event?.type === "tool-start") toolCalls++;
    const usage = event.type === "model-end" ? event.output?.usage : ["observation-end", "reflection-end"].includes(event.type) ? event.usage : undefined;
    if (usage) {
      const input = usage.inputTokens ?? (typeof usage.input === "number" ? usage.input + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0) : undefined);
      const output = usage.outputTokens ?? usage.output;
      if (typeof input === "number" && typeof output === "number") { knownInputTokens += input; knownOutputTokens += output; usageRecords++; }
      if (typeof usage.cost?.total === "number") { knownCostUsd += usage.cost.total; costRecords++; }
    }
  }
  const completeUsage = modelRequests > 0 && usageRecords === modelRequests;
  return { durationMs, modelRequests, directModelRequests, memoryCycles, requestDurationsMs, memoryCycleDurationsMs, toolCalls, knownInputTokens, knownOutputTokens, usageRecords, totalInputTokens: completeUsage ? knownInputTokens : null, totalOutputTokens: completeUsage ? knownOutputTokens : null, knownCostUsd, costRecords, totalCostUsd: modelRequests > 0 && costRecords === modelRequests ? knownCostUsd : null };
}
