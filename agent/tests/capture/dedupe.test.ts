import assert from "node:assert/strict";
import test from "node:test";

import {
  Dedupe,
  businessContentHash,
  contentSignature,
  shouldEmitObservation,
} from "../../src/capture/dedupe.js";
import type {
  ObservationContentSignature,
} from "../../src/capture/dedupe.js";

test("business content hashing is independent of object key order", () => {
  assert.equal(
    businessContentHash({
      role: "AXWindow",
      title: "Document",
      children: [{ role: "AXButton", title: "Save" }],
    }),
    businessContentHash({
      children: [{ title: "Save", role: "AXButton" }],
      title: "Document",
      role: "AXWindow",
    }),
  );
});

test("business-content hashing ignores frames, AX roles, capture bookkeeping, and visual signatures", () => {
  const capture = {
    capturedAt: "2026-07-27T00:00:01.000Z",
    validation: {
      preflightDurationMilliseconds: 2,
      attestationDurationMilliseconds: 1,
    },
    window: {
      processIdentifier: 101,
      applicationName: "Editor",
      windowIdentifier: 7,
      title: "Document",
    },
    screenshot: {
      status: "complete" as const,
      durationMilliseconds: 10,
      mimeType: "image/jpeg" as const,
      dataBase64: "AA==",
      width: 1,
      height: 1,
    },
    accessibility: {
      status: "complete" as const,
      durationMilliseconds: 10,
      snapshot: {
        root: {
          role: "AXWindow",
          title: "Document",
          frame: { x: 0, y: 0, width: 100, height: 100 },
        },
        nodeCount: 1,
        truncated: false,
      },
    },
    visualSignature: [0, 0],
  };
  const moved = {
    ...capture,
    capturedAt: "2026-07-27T00:00:02.000Z",
    visualSignature: [255, 255],
    accessibility: {
      ...capture.accessibility,
      durationMilliseconds: 99,
      snapshot: {
        ...capture.accessibility.snapshot,
        nodeCount: 500,
        truncated: true,
        root: {
          ...capture.accessibility.snapshot.root,
          role: "AXGroup",
          frame: { x: 20, y: 20, width: 100, height: 100 },
        },
      },
    },
  };

  assert.equal(
    contentSignature(capture).contentHash,
    contentSignature(moved).contentHash,
  );
});

test("content dedup emits when visual content changes without an AX semantic change", () => {
  const previous: ObservationContentSignature = {
    windowKey: "101:7",
    contentHash: "same",
    visualSignature: [0, 0],
  };
  const current: ObservationContentSignature = {
    ...previous,
    visualSignature: [255, 255],
  };

  assert.equal(shouldEmitObservation(previous, current, false, 0.015), true);
});

test("uses the runtime visual threshold as the standalone dedupe default", () => {
  const previous: ObservationContentSignature = {
    windowKey: "101:7",
    contentHash: "same",
    visualSignature: [0, 0],
  };
  const current: ObservationContentSignature = {
    ...previous,
    visualSignature: [10, 10],
  };

  assert.equal(shouldEmitObservation(previous, current, false), false);
});

test("content dedup does not reuse a capture with neither AX nor visual evidence", () => {
  const unavailable: ObservationContentSignature = {
    windowKey: "101:7",
    contentHash: "empty",
    semanticAvailable: false,
  };

  assert.equal(shouldEmitObservation(unavailable, unavailable, false), true);
});

test("does not treat an explicitly shell-only AX snapshot as semantic evidence", () => {
  const capture = {
    capturedAt: "2026-07-27T00:00:01.000Z",
    validation: {
      preflightDurationMilliseconds: 2,
      attestationDurationMilliseconds: 1,
    },
    window: {
      processIdentifier: 101,
      applicationName: "ChatGPT",
      windowIdentifier: 7,
    },
    screenshot: {
      status: "complete" as const,
      durationMilliseconds: 10,
      mimeType: "image/jpeg" as const,
      dataBase64: "AA==",
      width: 1,
      height: 1,
    },
    accessibility: {
      status: "complete" as const,
      quality: "shell_only" as const,
      durationMilliseconds: 10,
      contentRootFound: false,
      semanticNodeCount: 1,
      usefulTextCharacters: 0,
      snapshot: {
        root: { role: "AXWindow", title: "ChatGPT" },
        nodeCount: 1,
        truncated: false,
      },
    },
  };

  assert.equal(contentSignature(capture).semanticAvailable, false);
});

test("content dedup keeps boundaries and meaningful business-content changes", () => {
  const previous: ObservationContentSignature = {
    windowKey: "101:7",
    contentHash: "same",
  };

  assert.equal(shouldEmitObservation(previous, previous, false), false);
  assert.equal(shouldEmitObservation(previous, previous, true), true);
  assert.equal(
    shouldEmitObservation(previous, { ...previous, contentHash: "changed" }, false),
    true,
  );
  assert.equal(
    shouldEmitObservation(previous, { ...previous, windowKey: "202:9" }, false),
    true,
  );
});

test("dedupe advances only after an emitted signature is committed", () => {
  const dedupe = new Dedupe();
  const result = {
    capturedAt: "2026-07-27T00:00:01.000Z",
    validation: {
      preflightDurationMilliseconds: 2,
      attestationDurationMilliseconds: 1,
    },
    window: {
      processIdentifier: 101,
      applicationName: "Editor",
      windowIdentifier: 7,
    },
    screenshot: {
      status: "complete" as const,
      durationMilliseconds: 10,
      mimeType: "image/jpeg" as const,
      dataBase64: "AA==",
      width: 1,
      height: 1,
    },
    accessibility: {
      status: "complete" as const,
      durationMilliseconds: 10,
      snapshot: {
        root: { role: "AXWindow", title: "Document" },
        nodeCount: 1,
        truncated: false,
      },
    },
    visualSignature: [0, 0],
  };

  const candidate = dedupe.candidate(result, false);
  assert.ok(candidate);
  dedupe.commit(candidate);
  assert.equal(dedupe.candidate(result, false), undefined);
  assert.ok(dedupe.candidate(result, true));
});
