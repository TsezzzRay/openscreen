import { recordChronicleWindow } from "../../src/memory/mastra/write-path.js";
import { snapshot } from "../workspace.js";
import { executeChronicleWindow } from "./chronicle.js";
import type { WorkloadEnvironment } from "./environment.js";
import { withMemoryEnvironment } from "./memory.js";

export async function executeScreenActivityMemoryWorkload(environment: WorkloadEnvironment) {
  const { task, emit, memoryRoot } = environment;
  return withMemoryEnvironment(environment, async memory => {
    if (task.input.pipeline) return executeChronicleWindow(environment, memory);
    const { store, projector, observations } = memory;
    for (const [index, message] of task.input.messages!.entries()) {
      const text = typeof message === "string" ? message : message.text;
      const artifact = { relativePath: `rollout_summaries/${task.id}-${index}.md`, content: text };
      if (typeof message !== "string") await recordChronicleWindow({ store, projector }, text, artifact, message.capturedAt);
      else await recordChronicleWindow({ store, projector }, text, artifact);
      await projector.projectObservationLogs();
      emit({ type: "memory-snapshot", files: await snapshot(memoryRoot) });
    }
    return { observations };
  });
}
