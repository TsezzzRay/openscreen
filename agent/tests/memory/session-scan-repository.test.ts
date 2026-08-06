import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openMemoryDatabase } from "../../src/harness/memory/db/database.js";
import {
  SessionScanRepository,
} from "../../src/harness/memory/turn-memory/session-scan-repository.js";

test("durably skips unchanged valid and invalid Session files", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-session-scans-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const database = openMemoryDatabase(root);
  t.after(() => database.close());
  const scans = new SessionScanRepository(database);

  assert.equal(scans.shouldScan("session-1", "v1", false), true);
  scans.recordSuccess("session-1", "v1", false, 1);
  assert.equal(scans.shouldScan("session-1", "v1", false), false);
  assert.equal(scans.shouldScan("session-1", "v1", true), true);
  scans.recordSuccess("session-1", "v1", true, 2);
  assert.equal(scans.shouldScan("session-1", "v1", true), false);
  assert.equal(scans.shouldScan("session-1", "v2", false), true);

  scans.recordFailure("session-2", "bad-v1", "Invalid event at line 2", 3);
  assert.equal(scans.shouldScan("session-2", "bad-v1", false), false);
  assert.equal(scans.shouldScan("session-2", "bad-v1", true), false);
  assert.equal(scans.shouldScan("session-2", "bad-v2", false), true);

  const reopened = new SessionScanRepository(database);
  assert.equal(reopened.shouldScan("session-1", "v1", true), false);
  assert.equal(reopened.shouldScan("session-2", "bad-v1", false), false);
});
