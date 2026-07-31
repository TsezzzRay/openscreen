import assert from "node:assert/strict";
import test from "node:test";

import {
  Dedupe,
  axContentHash,
  shouldEmitObservation,
  visualDistance,
} from "../../src/plugins/screen-observation/dedupe.js";
import type {
  ObservationContentSignature,
} from "../../src/plugins/screen-observation/dedupe.js";

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

test("dedupe owns the last emitted signature", () => {
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
  assert.equal(dedupe.accept(result, false), true);
  assert.equal(dedupe.isNewWindow(result.window), false);
  assert.equal(dedupe.accept(result, false), false);
  assert.equal(dedupe.accept(result, true), true);
});
