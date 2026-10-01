import "../../src/memory/mastra/telemetry-guard.js";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PiAgentService } from "../../src/agent/pi/service.js";
import { openMastraMemoryStore } from "../../src/memory/mastra/store.js";
import { createMemoryProjector } from "../../src/memory/mastra/projector.js";
import { MEMORY_THREAD_IDS } from "../../src/memory/mastra/thread-ids.js";
import type { Task } from "../dataset.js";
import { snapshot } from "../workspace.js";
import type { WorkloadEnvironment } from "./environment.js";

export function observationMessageTokens(task: Task): number {
  return task.workload === "chronicle" ? 1_000_000 : 1;
}

export interface MemoryEnvironment {
  store: ReturnType<typeof openMastraMemoryStore>;
  projector: ReturnType<typeof createMemoryProjector>;
  observations: unknown[];
}

/** Share store lifetime, observation tracing, projection and retrieval across Memory flows. */
export async function withMemoryEnvironment(environment: WorkloadEnvironment, execute: (memory: MemoryEnvironment) => Promise<unknown>) {
  const { task, root, config, model, emit, memoryRoot, options, runPrompt } = environment;
  // Observation fixtures deliberately cross a recorded, lowered threshold.
  // Chronicle uses a high threshold so its downstream observer stays idle.
  const memoryConfig = structuredClone(config.memory);
  for (const policy of Object.values(memoryConfig.observationalMemory)) {
    policy.messageTokens = observationMessageTokens(task);
    policy.observationTokens = 1_000_000;
  }
  emit({ type: "memory-policy", policy: memoryConfig.observationalMemory });
  await mkdir(join(root, "store"), { recursive: true });
  const store = openMastraMemoryStore(join(root, "store"), memoryConfig, model);
  const observations: unknown[] = [];
  for (const om of [store.interactive, store.screenActivity]) {
    const observe = om.observe.bind(om);
    om.observe = async args => {
      let observationStarted = 0, reflectionStarted = 0;
      const result = await observe({ ...args, hooks: {
        onObservationStart: () => { environment.countModelCall(); observationStarted = Date.now(); emit({ type: "observation-start" }); },
        onObservationEnd: result => emit({ type: "observation-end", durationMs: Date.now() - observationStarted, usage: result.usage, error: result.error?.message }),
        onReflectionStart: () => { environment.countModelCall(); reflectionStarted = Date.now(); emit({ type: "reflection-start" }); },
        onReflectionEnd: result => emit({ type: "reflection-end", durationMs: Date.now() - reflectionStarted, usage: result.usage, error: result.error?.message }),
      } });
      observations.push(result);
      emit({ type: "observation-result", result });
      return result;
    };
  }
  const projector = createMemoryProjector(memoryRoot, store);
  try {
    let output = await execute({ store, projector, observations });
    if (task.input.reflect) {
      const beforeReflection = await snapshot(memoryRoot);
      const started = Date.now();
      environment.countModelCall(); emit({ type: "reflection-start", trigger: "eval-manual" });
      const reflection = await store.interactive.reflect(MEMORY_THREAD_IDS.interactive, MEMORY_THREAD_IDS.resourceId);
      emit({ type: "reflection-end", durationMs: Date.now() - started, usage: reflection.usage, reflected: reflection.reflected });
      if (!reflection.reflected) throw new Error("Reflection fixture did not produce a reflection");
      output = { observations, beforeReflection, reflection };
    }
    await projector.projectObservationLogs();
    if (task.input.followUp) {
      const agent = new PiAgentService(options);
      const sessionId = (await agent.createSession()).session.id;
      const followUp = await runPrompt(agent, sessionId, { text: task.input.followUp });
      output = { ...(output as object), followUp, sessions: await snapshot(join(root, "sessions")) };
    }
    return output;
  } finally { await store.close(); }
}
