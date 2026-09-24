import "../src/memory/mastra/telemetry-guard.js";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { executeWorkload } from "./workloads.js";
import type { Task } from "./dataset.js";
import type { ApplicationConfig } from "../src/runtime-config.js";

process.once("message", async (message: { task: Task; root: string; config: ApplicationConfig }) => {
  try {
    const models = builtinModels();
    const model = models.getModel(message.config.agent.provider, message.config.agent.model);
    if (!model) throw new Error("Configured eval model is not available");
    const result = await executeWorkload(message.task, message.root, message.config, models, model, event => process.send?.({ type: "event", event }));
    process.send?.({ type: "result", result }, () => process.exit(0));
  } catch (error) {
    process.send?.({ type: "error", error: error instanceof Error ? error.message : String(error) }, () => process.exit(1));
  }
});
