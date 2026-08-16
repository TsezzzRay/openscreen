import assert from "node:assert/strict";
import test from "node:test";

import type {
  CapturedFrameImage,
  CapturedContext,
  CaptureService,
} from "../../src/capture/api.js";
import type { ScreenFrameSource } from "../../src/capture/screenpipe/frame-source.js";

test("neutral CaptureService boundary exposes only lifecycle and request capture", () => {
  const service: CaptureService = {
    start: async () => {},
    stop: async () => {},
    capture: async (): Promise<CapturedContext> => ({
      type: "frames",
      frames: [],
      images: [],
    }),
  };

  assert.deepEqual(Object.keys(service).sort(), ["capture", "start", "stop"]);
});

test("CapturedContext preserves frame-source identity without copying its shape", () => {
  const frame: ScreenFrameSource = {
    sourceId: "source-1",
    generationId: "generation-1",
    frameId: "1",
    monitorKey: "1",
    deviceName: "Display",
    capturedAt: "2026-08-15T01:02:03.000Z",
    trigger: "request",
    imagePath: "/private/1_m1.jpg",
  };
  const image: CapturedFrameImage = {
    sourceId: frame.sourceId,
    data: Uint8Array.of(0xff, 0xd8),
    mimeType: "image/jpeg",
  };
  const context: CapturedContext = {
    type: "frames",
    frames: [frame],
    images: [image],
  };

  assert.equal(context.type, "frames");
  assert.deepEqual(context.frames, [frame]);
  assert.deepEqual(context.images, [image]);
});
