import assert from "node:assert/strict";
import test from "node:test";

import {
  buildScreenpipeRecorderOptions,
  SCREENPIPE_TELEMETRY_ENV,
} from "../../../src/capture/screenpipe/recorder.js";

test("builds the privacy-preserving all-monitor recorder contract", () => {
  const options = buildScreenpipeRecorderOptions({
    dataDir: "/tmp/openscreen-screenpipe-generation",
    ignoredWindows: ["OpenScreen", "Password Manager"],
    ignoredUrls: ["bank.example"],
  });

  assert.deepEqual(options, {
    dataDir: "/tmp/openscreen-screenpipe-generation",
    output: "/tmp/openscreen-screenpipe-generation/disabled.mp4",
    mp4Monitors: [],
    pairedMonitors: undefined,
    microphone: false,
    systemAudio: false,
    ignoredWindows: ["OpenScreen", "Password Manager"],
    ignoredUrls: ["bank.example"],
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
  });
  assert.deepEqual(SCREENPIPE_TELEMETRY_ENV, {
    SCREENPIPE_SDK_TELEMETRY: "0",
  });
});

test("rejects a relative Screenpipe data directory", () => {
  assert.throws(
    () => buildScreenpipeRecorderOptions({
      dataDir: "relative-generation",
      ignoredWindows: [],
      ignoredUrls: [],
    }),
    /absolute/,
  );
});
