import { summarizeChronicleWindow } from "../../src/memory/chronicle/processor.js";
import type { ChronicleFrameProjection } from "../../src/memory/chronicle/types.js";
import type { Task } from "../dataset.js";
import type { WorkloadEnvironment } from "./environment.js";
import { withMemoryEnvironment, type MemoryEnvironment } from "./memory.js";

/** Preserve capture timestamps supplied by a scenario while retaining the legacy default for older fixtures. */
export function projectEvalChronicleFrames(frames: NonNullable<Task["input"]["frames"]>): ChronicleFrameProjection[] {
  return frames.map((frame, index) => ({
    type: "screenpipe_frame", sourceId: `frame-${index + 1}`, frameId: String(index + 1), generationId: "eval",
    monitorKey: "display-1", deviceName: "fixture",
    capturedAt: frame.capturedAt ?? new Date(Date.parse("2026-09-01T09:00:00Z") + index * 1000).toISOString(),
    trigger: "click", application: frame.application,
    ...(frame.windowTitle === undefined ? {} : { windowTitle: frame.windowTitle }), visibleText: frame.text,
  }));
}

/** The same Chronicle production path serves standalone and screen-Memory pipeline tasks. */
export async function executeChronicleWindow(environment: WorkloadEnvironment, memory: MemoryEnvironment) {
  const { task, config, models, model } = environment;
  const { store, projector } = memory;
  const frames = projectEvalChronicleFrames(task.input.frames!);
  const output = await summarizeChronicleWindow({ windowId: task.id, frames, policy: config.memory.chronicle, models, model, writePath: { store, projector }, now: () => task.input.frames!.some(frame => frame.capturedAt !== undefined)
    ? Math.max(...frames.map(frame => Date.parse(frame.capturedAt))) + 60_000
    : Date.parse("2026-09-01T09:01:00Z") });
  if ((output as { status: string }).status === "failed") throw new Error(JSON.stringify(output));
  return output;
}

export async function executeChronicleWorkload(environment: WorkloadEnvironment) {
  return withMemoryEnvironment(environment, memory => executeChronicleWindow(environment, memory));
}
