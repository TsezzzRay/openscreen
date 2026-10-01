import "../../src/memory/mastra/telemetry-guard.js";
import type { Model, Models } from "@earendil-works/pi-ai";
import type { ApplicationConfig } from "../../src/runtime-config.js";
import type { Task } from "../dataset.js";
import { snapshot } from "../workspace.js";
import { verifyTask } from "../verification.js";
import { executeAgentWorkload } from "./agent.js";
import { executeCompactionWorkload } from "./compaction.js";
import { executeChronicleWorkload } from "./chronicle.js";
import { executeInteractiveMemoryWorkload } from "./interactive-memory.js";
import { executeScreenActivityMemoryWorkload } from "./screen-activity-memory.js";
import { withWorkloadEnvironment } from "./environment.js";

const workloads = {
  agent: executeAgentWorkload,
  compaction: executeCompactionWorkload,
  chronicle: executeChronicleWorkload,
  "interactive-memory": executeInteractiveMemoryWorkload,
  "screen-activity-memory": executeScreenActivityMemoryWorkload,
};

export async function executeWorkload(task: Task, root: string, config: ApplicationConfig, originalModels: Models, model: Model<string>, emit: (event: unknown) => void) {
  return withWorkloadEnvironment(task, root, config, originalModels, model, emit, async environment => {
    let output: unknown = await workloads[task.workload](environment);
    const modelCalls = await environment.settleModelCalls();
    const after = await snapshot(environment.workspace);
    const taskVerification = await verifyTask(task, environment.workspace, environment.before, after);
    if (taskVerification) output = { ...(output as object), taskVerification };
    return { output, before: environment.before, after, modelCalls };
  });
}
