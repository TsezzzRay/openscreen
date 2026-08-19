import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openMemoryCursors } from "../../src/memory/cursors.js";
import type { ChronicleFrameInput } from "../../src/memory/chronicle/types.js";

const chroniclePolicy = { windowMilliseconds: 60_000, graceMilliseconds: 15_000 };

function frame(id: number, capturedAt: string): ChronicleFrameInput {
  return {
    sourceId: `screenpipe-frame:gen-1:${id}`,
    generationId: "gen-1",
    frameId: String(id),
    monitorKey: "1",
    deviceName: "Display 1",
    capturedAt,
    trigger: "periodic",
  };
}

async function withCursors(fn: (cursors: ReturnType<typeof openMemoryCursors>) => Promise<void> | void) {
  const root = await mkdtemp(join(tmpdir(), "openscreen-cursors-"));
  const cursors = openMemoryCursors(root);
  try {
    await fn(cursors);
  } finally {
    cursors.close();
    await rm(root, { recursive: true, force: true });
  }
}

test("Turn scan cursor tracks file version and last terminal entry", async () => {
  await withCursors((cursors) => {
    assert.equal(cursors.shouldScanSession("s1", "v1"), true);
    cursors.recordTurnScanSuccess({ sessionId: "s1", fileVersion: "v1", lastTerminalEntryId: "e1", scannedAt: 1 });
    assert.equal(cursors.shouldScanSession("s1", "v1"), false);
    assert.equal(cursors.shouldScanSession("s1", "v2"), true);
    assert.deepEqual(cursors.loadTurnScanCursor("s1"), {
      fileVersion: "v1",
      lastTerminalEntryId: "e1",
      status: "valid",
    });
  });
});

test("Turn scan cursor records failures without a terminal entry", async () => {
  await withCursors((cursors) => {
    cursors.recordTurnScanFailure({ sessionId: "s1", fileVersion: "broken", error: "bad session", scannedAt: 1 });
    assert.deepEqual(cursors.loadTurnScanCursor("s1"), {
      fileVersion: "broken",
      status: "invalid",
      lastError: "bad session",
    });
    // Same fileVersion again: matches shouldScanSession's "wait for a change" semantics.
    assert.equal(cursors.shouldScanSession("s1", "broken"), false);
  });
});

test("Chronicle generation cursor starts at zero and advances under ownership", async () => {
  await withCursors((cursors) => {
    assert.equal(cursors.chronicleGenerationCursor("gen-1"), 0);
    assert.equal(cursors.chronicleGenerationComplete("gen-1"), false);
    assert.equal(cursors.advanceChronicleGenerationCursor("gen-1", 0, 10, 1), true);
    assert.equal(cursors.chronicleGenerationCursor("gen-1"), 10);
    // Stale expectedCursor is rejected.
    assert.equal(cursors.advanceChronicleGenerationCursor("gen-1", 0, 20, 2), false);
    assert.equal(cursors.advanceChronicleGenerationCursor("gen-1", 10, 20, 2), true);
  });
});

test("Chronicle generation completes only once the cursor matches and blocks further advances", async () => {
  await withCursors((cursors) => {
    cursors.advanceChronicleGenerationCursor("gen-1", 0, 5, 1);
    assert.equal(cursors.completeChronicleGeneration("gen-1", 4, 2), false);
    assert.equal(cursors.completeChronicleGeneration("gen-1", 5, 2), true);
    assert.equal(cursors.chronicleGenerationComplete("gen-1"), true);
    assert.equal(cursors.advanceChronicleGenerationCursor("gen-1", 5, 6, 3), false);
  });
});

test("Chronicle window buffer batches frames and becomes due after the grace period", async () => {
  await withCursors((cursors) => {
    const occurredAt = Date.parse("2026-08-19T09:00:10.000Z");
    const eligibleAt = Math.floor(occurredAt / 60_000) * 60_000 + 60_000 + 15_000;
    cursors.ingestChronicleFrame(frame(1, "2026-08-19T09:00:10.000Z"), chroniclePolicy, occurredAt);
    cursors.ingestChronicleFrame(frame(2, "2026-08-19T09:00:20.000Z"), chroniclePolicy, occurredAt);
    assert.deepEqual(cursors.dueChronicleWindows(eligibleAt - 1), []);
    const due = cursors.dueChronicleWindows(eligibleAt);
    assert.equal(due.length, 1);
    const frames = cursors.loadChronicleWindowFrames(due[0]!.windowId);
    assert.equal(frames.length, 2);
    assert.deepEqual(frames.map((f) => f.sourceId), [
      "screenpipe-frame:gen-1:1",
      "screenpipe-frame:gen-1:2",
    ]);
  });
});

test("Marking a window summarized deletes its pending frames and removes it from the due list", async () => {
  await withCursors((cursors) => {
    const occurredAt = Date.parse("2026-08-19T09:00:10.000Z");
    const eligibleAt = Math.floor(occurredAt / 60_000) * 60_000 + 60_000 + 15_000;
    const { windowId } = cursors.ingestChronicleFrame(frame(1, "2026-08-19T09:00:10.000Z"), chroniclePolicy, occurredAt);
    cursors.markChronicleWindowSummarized(windowId, eligibleAt);
    assert.deepEqual(cursors.dueChronicleWindows(eligibleAt), []);
    assert.deepEqual(cursors.loadChronicleWindowFrames(windowId), []);
  });
});

test("A frame arriving after its window is already summarized is dropped, not re-queued", async () => {
  await withCursors((cursors) => {
    const occurredAt = Date.parse("2026-08-19T09:00:10.000Z");
    const eligibleAt = Math.floor(occurredAt / 60_000) * 60_000 + 60_000 + 15_000;
    const { windowId } = cursors.ingestChronicleFrame(frame(1, "2026-08-19T09:00:10.000Z"), chroniclePolicy, occurredAt);
    cursors.markChronicleWindowSummarized(windowId, eligibleAt);
    cursors.ingestChronicleFrame(frame(2, "2026-08-19T09:00:15.000Z"), chroniclePolicy, occurredAt + 1_000);
    assert.deepEqual(cursors.dueChronicleWindows(eligibleAt + 1_000), []);
    assert.deepEqual(cursors.loadChronicleWindowFrames(windowId), []);
  });
});

test("Chronicle window attempts are capped so a permanently-broken window stops retrying", async () => {
  await withCursors((cursors) => {
    const occurredAt = Date.parse("2026-08-19T09:00:10.000Z");
    const eligibleAt = Math.floor(occurredAt / 60_000) * 60_000 + 60_000 + 15_000;
    const { windowId } = cursors.ingestChronicleFrame(frame(1, "2026-08-19T09:00:10.000Z"), chroniclePolicy, occurredAt);
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      assert.equal(cursors.recordChronicleWindowAttempt(windowId), attempt);
    }
    assert.deepEqual(cursors.dueChronicleWindows(eligibleAt), []);
  });
});
