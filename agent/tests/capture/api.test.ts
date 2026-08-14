import assert from "node:assert/strict";
import test from "node:test";

import type {
  CapturedContext,
  CaptureService,
} from "../../src/capture/api.js";

test("neutral CaptureService boundary exposes only lifecycle and request capture", () => {
  const service: CaptureService = {
    start: async () => {},
    stop: async () => {},
    capture: async (requestId): Promise<CapturedContext> => ({
      requestId,
      captureId: "capture-1",
      occurredAt: "2026-08-07T00:00:00.000Z",
      capturedAt: "2026-08-07T00:00:00.100Z",
      status: "unavailable",
      target: {
        application: {
          processIdentifier: 100,
          name: "Editor",
        },
        window: { identifier: 7 },
      },
      diagnostics: {
        intentRevision: 1,
        artifactRevision: 1,
        completedRevision: 1,
        intentContentEpoch: 0,
        artifactContentEpoch: 0,
        completedContentEpoch: 0,
        screenshotStatus: "unavailable",
        accessibilityStatus: "unavailable",
      },
    }),
  };

  assert.deepEqual(Object.keys(service).sort(), ["capture", "start", "stop"]);
});
