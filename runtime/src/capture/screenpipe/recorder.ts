import { isAbsolute, join } from "node:path";

import type { RecorderOptions } from "@screenpipe/sdk";

export const SCREENPIPE_TELEMETRY_ENV = Object.freeze({
  SCREENPIPE_SDK_TELEMETRY: "0",
});

export type ScreenpipeRecorderContractInput = {
  dataDir: string;
  ignoredWindows: string[];
  ignoredUrls: string[];
};

export function buildScreenpipeRecorderOptions(
  input: ScreenpipeRecorderContractInput,
): RecorderOptions {
  if (!isAbsolute(input.dataDir)) {
    throw new Error("Screenpipe dataDir must be absolute");
  }
  return {
    dataDir: input.dataDir,
    output: join(input.dataDir, "disabled.mp4"),
    mp4Monitors: [],
    pairedMonitors: undefined,
    microphone: false,
    systemAudio: false,
    ignoredWindows: input.ignoredWindows,
    ignoredUrls: input.ignoredUrls,
    uiCapture: {
      captureClicks: true,
      captureText: true,
      captureKeystrokes: false,
      captureAppSwitch: true,
      captureWindowFocus: true,
      captureScroll: false,
      captureClipboard: false,
      captureClipboardContent: false,
      captureContext: true,
      captureMouseMove: false,
    },
  };
}
