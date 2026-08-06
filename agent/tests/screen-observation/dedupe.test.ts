import assert from "node:assert/strict";
import test from "node:test";

import {
  Dedupe,
  axContentHash,
  contentSignature,
  shouldEmitObservation,
  visualDistance,
} from "../../src/extensions/screen-observation/dedupe.js";
import type {
  ObservationContentSignature,
} from "../../src/extensions/screen-observation/dedupe.js";

test("AX content hashing is independent of object key order", () => {
  assert.equal(
    axContentHash({
      role: "AXWindow",
      title: "Document",
      children: [{ role: "AXButton", title: "Save" }],
    }),
    axContentHash({
      children: [{ title: "Save", role: "AXButton" }],
      title: "Document",
      role: "AXWindow",
    }),
  );
});

test("semantic AX dedup ignores frames and capture bookkeeping", () => {
  const capture = {
    capturedAt: "2026-07-27T00:00:01.000Z",
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
    accessibility: {
      ...capture.accessibility,
      durationMilliseconds: 99,
      snapshot: {
        ...capture.accessibility.snapshot,
        nodeCount: 500,
        truncated: true,
        root: {
          ...capture.accessibility.snapshot.root,
          frame: { x: 20, y: 20, width: 100, height: 100 },
        },
      },
    },
  };

  assert.equal(
    contentSignature(capture).accessibilityHash,
    contentSignature(moved).accessibilityHash,
  );
});

test("content dedup keeps boundaries and meaningful AX or visual changes", () => {
  const previous: ObservationContentSignature = {
    windowKey: "101:7",
    accessibilityHash: "same",
    visualSignature: [0, 0, 0, 0],
  };

  assert.equal(shouldEmitObservation(previous, previous, false, 0.08), false);
  assert.equal(shouldEmitObservation(previous, previous, true, 0.08), true);
  assert.equal(
    shouldEmitObservation(previous, { ...previous, accessibilityHash: "changed" }, false, 0.08),
    true,
  );
  assert.equal(
    shouldEmitObservation(
      previous,
      { ...previous, visualSignature: [255, 255, 255, 255] },
      false,
      0.08,
    ),
    true,
  );
  assert.equal(
    shouldEmitObservation(previous, { ...previous, windowKey: "202:9" }, false, 0.08),
    true,
  );
});

test("visual distance is normalized mean absolute pixel difference", () => {
  assert.equal(visualDistance([0, 0], [255, 255]), 1);
  assert.equal(visualDistance([0, 255], [0, 255]), 0);
  assert.equal(visualDistance([0], [0, 1]), 1);
});

test("dedupe advances only after an emitted signature is committed", () => {
  const dedupe = new Dedupe(0.08);
  const result = {
    capturedAt: "2026-07-27T00:00:01.000Z",
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

  assert.equal(dedupe.isNewWindow(result.window), true);
  const candidate = dedupe.candidate(result, false);
  assert.ok(candidate);
  assert.equal(dedupe.isNewWindow(result.window), true);
  dedupe.commit(candidate);
  assert.equal(dedupe.isNewWindow(result.window), false);
  assert.equal(dedupe.candidate(result, false), undefined);
  assert.ok(dedupe.candidate(result, true));
});
