import type {
  ChronicleFrameInput,
  ChronicleFrameProjection,
} from "./types.js";

function bounded(value: string | undefined, maximum: number): string | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  return Array.from(value.trim()).slice(0, maximum).join("");
}

export function projectChronicleFrame(
  frame: ChronicleFrameInput,
): ChronicleFrameProjection {
  if (
    !frame.sourceId || !frame.generationId || !frame.frameId || !frame.monitorKey ||
    !frame.deviceName || !frame.capturedAt || !frame.trigger ||
    !Number.isFinite(Date.parse(frame.capturedAt))
  ) {
    throw new Error("Invalid Screenpipe frame for Chronicle");
  }
  return {
    type: "screenpipe_frame",
    sourceId: frame.sourceId,
    generationId: frame.generationId,
    frameId: frame.frameId,
    monitorKey: frame.monitorKey,
    deviceName: bounded(frame.deviceName, 500)!,
    capturedAt: frame.capturedAt,
    trigger: bounded(frame.trigger, 200)!,
    ...(bounded(frame.application, 500) === undefined
      ? {}
      : { application: bounded(frame.application, 500) }),
    ...(bounded(frame.windowTitle, 1_000) === undefined
      ? {}
      : { windowTitle: bounded(frame.windowTitle, 1_000) }),
    ...(bounded(frame.url, 2_048) === undefined ? {} : { url: bounded(frame.url, 2_048) }),
    ...(bounded(frame.visibleText, 8_000) === undefined
      ? {}
      : { visibleText: bounded(frame.visibleText, 8_000) }),
  };
}
