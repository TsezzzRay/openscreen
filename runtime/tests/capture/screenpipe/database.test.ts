import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { openScreenpipeDatabase } from "../../../src/capture/screenpipe/database.js";

type SqlValue = null | number | string;

type FrameInsert = {
  id: SqlValue;
  timestamp: SqlValue;
  deviceName: SqlValue;
  snapshotPath: SqlValue;
  captureTrigger: SqlValue;
  appName?: SqlValue;
  windowName?: SqlValue;
  browserUrl?: SqlValue;
  focused?: SqlValue;
  accessibilityText?: SqlValue;
};

async function createFramesDatabase(rows: FrameInsert[]): Promise<{
  path: string;
  root: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "openscreen-screenpipe-db-"));
  const path = join(root, "db.sqlite");
  const database = new DatabaseSync(path);
  database.exec(`
    CREATE TABLE frames (
      id INTEGER,
      video_chunk_id,
      offset_index,
      timestamp,
      name,
      app_name,
      window_name,
      focused,
      browser_url,
      device_name,
      snapshot_path,
      accessibility_text,
      accessibility_tree_json,
      content_hash,
      simhash,
      capture_trigger,
      text_source
    );
  `);
  const insert = database.prepare(`
    INSERT INTO frames (
      id,
      timestamp,
      app_name,
      window_name,
      focused,
      browser_url,
      device_name,
      snapshot_path,
      accessibility_text,
      capture_trigger
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const row of rows) {
    insert.run(
      row.id,
      row.timestamp,
      row.appName ?? null,
      row.windowName ?? null,
      row.focused ?? null,
      row.browserUrl ?? null,
      row.deviceName,
      row.snapshotPath,
      row.accessibilityText ?? null,
      row.captureTrigger,
    );
  }
  database.close();
  return { path, root };
}

test("drops rows with invalid frame fields and preserves nullable fields", async (t) => {
  const database = await createFramesDatabase([
    {
      id: "not-an-integer",
      timestamp: "2026-08-15T01:00:01.000Z",
      deviceName: "Invalid ID",
      snapshotPath: "/missing/1770000000010_m4.jpg",
      captureTrigger: "click",
    },
    {
      id: 51,
      timestamp: "not-an-iso-date",
      deviceName: "Valid Nullable",
      snapshotPath: "/missing/1770000000011_m4.jpg",
      captureTrigger: "click",
    },
    {
      id: 52,
      timestamp: "2026-02-30T01:00:03.000Z",
      deviceName: "Invalid Timestamp",
      snapshotPath: "/missing/1770000000012_m4.jpg",
      captureTrigger: "click",
    },
    {
      id: 53,
      timestamp: "2026-08-15T01:00:04.000Z",
      deviceName: "",
      snapshotPath: "/missing/1770000000013_m4.jpg",
      captureTrigger: "click",
    },
    {
      id: 54,
      timestamp: "2026-08-15T01:00:05.000Z",
      deviceName: "Invalid Trigger",
      snapshotPath: "/missing/1770000000014_m4.jpg",
      captureTrigger: "",
    },
    {
      id: 55,
      timestamp: "2026-08-15T01:00:06.000Z",
      deviceName: "Invalid Path",
      snapshotPath: "",
      captureTrigger: "click",
    },
    {
      id: 56,
      timestamp: "2026-01-01T01:00:00.000Z",
      deviceName: "Valid Nullable",
      snapshotPath: "/missing/1770000000015_m4.jpg",
      captureTrigger: "click",
      appName: null,
      windowName: null,
      browserUrl: null,
      focused: null,
      accessibilityText: null,
    },
    {
      id: 57,
      timestamp: "2026-08-15T01:00:00.000Z",
      deviceName: "Empty Text",
      snapshotPath: "/missing/1770000000016_m5.jpg",
      captureTrigger: "click",
      accessibilityText: "",
    },
  ]);
  t.after(() => rm(database.root, { recursive: true, force: true }));

  const source = openScreenpipeDatabase(database.path, "generation-nullable", []);
  t.after(() => source.close());

  const frames = source.framesAfter(0, 20).frames;
  assert.deepEqual(frames, [
    {
      sourceId: 'screenpipe-frame:generation-nullable:56',
      generationId: "generation-nullable",
      frameId: "56",
      monitorKey: "4",
      deviceName: "Valid Nullable",
      capturedAt: "2026-01-01T01:00:00.000Z",
      trigger: "click",
      imagePath: "/missing/1770000000015_m4.jpg",
    },
    {
      sourceId: 'screenpipe-frame:generation-nullable:57',
      generationId: "generation-nullable",
      frameId: "57",
      monitorKey: "5",
      deviceName: "Empty Text",
      capturedAt: "2026-08-15T01:00:00.000Z",
      trigger: "click",
      imagePath: "/missing/1770000000016_m5.jpg",
      visibleText: "",
    },
  ]);
  for (const frame of frames) {
    assert.equal("watermark" in frame, false);
    assert.equal("freshness" in frame, false);
    assert.equal("age" in frame, false);
    assert.equal("skew" in frame, false);
    assert.equal("group" in frame, false);
  }
});

test("reads a bounded id-ordered increment while advancing past invalid rows", async (t) => {
  const database = await createFramesDatabase([
    {
      id: 1,
      timestamp: "2026-08-15T01:00:00.000Z",
      deviceName: "First Display",
      snapshotPath: "/missing/1770000000201_m1.jpg",
      captureTrigger: "click",
    },
    {
      id: 2,
      timestamp: "not-a-timestamp",
      deviceName: "Invalid Display",
      snapshotPath: "/missing/1770000000202_m2.jpg",
      captureTrigger: "click",
    },
    {
      id: 3,
      timestamp: "2026-08-15T01:00:02.000Z",
      deviceName: "Third Display",
      snapshotPath: "/missing/1770000000203_m3.jpg",
      captureTrigger: "focus",
    },
    {
      id: 4,
      timestamp: "2026-08-15T01:00:03.000Z",
      deviceName: "",
      snapshotPath: "/missing/1770000000204_m4.jpg",
      captureTrigger: "click",
    },
  ]);
  t.after(() => rm(database.root, { recursive: true, force: true }));

  const source = openScreenpipeDatabase(database.path, "generation-increment", []);
  t.after(() => source.close());

  const first = source.framesAfter(0, 2);
  assert.deepEqual(first.frames.map((frame) => frame.frameId), ["1"]);
  assert.equal(first.cursor, 2);
  assert.equal(first.hasMore, true);

  const second = source.framesAfter(first.cursor, 2);
  assert.deepEqual(second.frames.map((frame) => frame.frameId), ["3"]);
  assert.equal(second.cursor, 4);
  assert.equal(second.hasMore, false);

  assert.deepEqual(source.framesAfter(second.cursor, 2), {
    frames: [],
    cursor: 4,
    hasMore: false,
  });
});

test("drops frames matching ignoredWindows, case-insensitively, by app name or window title", async (t) => {
  const database = await createFramesDatabase([
    {
      id: 61,
      timestamp: "2026-08-15T01:00:00.000Z",
      deviceName: "Display 1",
      snapshotPath: "/missing/1770000000061_m1.jpg",
      captureTrigger: "click",
      appName: "OpenScreen",
      accessibilityText: "own chat window, should be dropped",
    },
    {
      id: 62,
      timestamp: "2026-08-15T01:00:01.000Z",
      deviceName: "Display 1",
      snapshotPath: "/missing/1770000000062_m1.jpg",
      captureTrigger: "click",
      appName: "openscreen",
      accessibilityText: "same app, different case, still dropped",
    },
    {
      id: 63,
      timestamp: "2026-08-15T01:00:02.000Z",
      deviceName: "Display 1",
      snapshotPath: "/missing/1770000000063_m1.jpg",
      captureTrigger: "click",
      appName: "Finder",
      windowName: "OpenScreen debug notes",
      accessibilityText: "matches via window title instead of app name",
    },
    {
      id: 64,
      timestamp: "2026-08-15T01:00:03.000Z",
      deviceName: "Display 1",
      snapshotPath: "/missing/1770000000064_m1.jpg",
      captureTrigger: "click",
      appName: "Ghostty",
      accessibilityText: "unrelated app, kept",
    },
  ]);
  t.after(() => rm(database.root, { recursive: true, force: true }));

  const source = openScreenpipeDatabase(database.path, "generation-ignored", ["OpenScreen"]);
  t.after(() => source.close());

  assert.deepEqual(
    source.framesAfter(0, 10).frames.map((frame) => frame.frameId),
    ["64"],
  );
});

test("requires a non-empty generation id", async (t) => {
  const database = await createFramesDatabase([]);
  t.after(() => rm(database.root, { recursive: true, force: true }));

  assert.throws(
    () => openScreenpipeDatabase(database.path, "", []),
    /generationId/,
  );
});
