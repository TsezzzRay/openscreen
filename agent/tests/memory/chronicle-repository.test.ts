import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ChronicleRepository } from "../../src/harness/memory/chronicle/repository.js";
import { openMemoryDatabase } from "../../src/harness/memory/db/database.js";
import type { ScreenObservation } from "../../src/extensions/screen-observation/types.js";
import { testMemoryConfig } from "./test-config.js";

function observation(id: string, occurredAt: string): ScreenObservation {
  return {
    schemaVersion: 1,
    id,
    occurredAt,
    capturedAt: new Date(Date.parse(occurredAt) + 100).toISOString(),
    trigger: { type: "focusedWindowChanged" },
    window: { processIdentifier: 42, applicationName: "Safari", title: "Memory" },
    screenshot: { status: "complete", durationMilliseconds: 1 },
    accessibility: { status: "complete", durationMilliseconds: 1 },
    visibleText: `Observation ${id}`,
    diagnostics: {
      triggerToCaptureMilliseconds: 100,
      screenshotDurationMilliseconds: 1,
      accessibilityDurationMilliseconds: 1,
    },
  };
}

test("persists, claims, and commits a Chronicle window without raw memory", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-chronicle-repository-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const database = openMemoryDatabase(root);
  t.after(() => database.close());
  const repository = new ChronicleRepository(database, testMemoryConfig());
  const ingested = repository.ingestObservation(
    observation("1", "2026-08-04T10:00:42.000Z"),
    Date.parse("2026-08-04T10:00:42.100Z"),
  );
  assert.equal(ingested.duplicate, false);

  const claim = repository.claimNext({
    workerId: "chronicle-worker",
    now: Date.parse("2026-08-04T10:01:15.000Z"),
  });
  assert.ok(claim);
  assert.deepEqual(
    repository.loadClaimSources(claim).map(({ sourceId }) => sourceId),
    ["observation:1"],
  );
  repository.complete(claim, {
    activities: [{
      summary: "The user viewed an OpenScreen memory page.",
      sourceIds: ["observation:1"],
      application: "Safari",
      windowTitle: "Memory",
    }],
    sourceSummary: "The user viewed OpenScreen memory material.",
  }, Date.parse("2026-08-04T10:01:20.000Z"));

  assert.equal(database.connection.prepare(`
    SELECT status FROM memory_jobs WHERE job_key = ?
  `).get(claim.jobKey)?.status, "succeeded");
  assert.equal(database.connection.prepare(`
    SELECT count(*) AS count FROM chronicle_activities
  `).get()?.count, 1);
  assert.equal(database.connection.prepare(`
    SELECT source_summary FROM chronicle_summaries WHERE job_key = ?
  `).get(claim.jobKey)?.source_summary,
  "The user viewed OpenScreen memory material.");
  const columns = (database.connection.prepare(`
    PRAGMA table_info(chronicle_summaries)
  `).all() as Array<{ name: string }>).map(({ name }) => name);
  assert.equal(columns.includes("raw_memory"), false);
});

test("late Chronicle evidence fences the previous generation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-chronicle-repository-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const database = openMemoryDatabase(root);
  t.after(() => database.close());
  const repository = new ChronicleRepository(database, testMemoryConfig());
  repository.ingestObservation(
    observation("1", "2026-08-04T10:00:10.000Z"),
    Date.parse("2026-08-04T10:00:10.100Z"),
  );
  const claim = repository.claimNext({
    workerId: "chronicle-worker",
    now: Date.parse("2026-08-04T10:01:15.000Z"),
  });
  assert.ok(claim);
  repository.ingestObservation(
    observation("2", "2026-08-04T10:00:50.000Z"),
    Date.parse("2026-08-04T10:01:20.000Z"),
  );

  assert.equal(repository.heartbeat(claim, Date.parse("2026-08-04T10:01:21.000Z")), false);
  assert.throws(() => repository.complete(claim, {
    activities: [{ summary: "Old", sourceIds: ["observation:1"] }],
    sourceSummary: "Old",
  }, Date.parse("2026-08-04T10:01:22.000Z")), /ownership lost/i);
});
