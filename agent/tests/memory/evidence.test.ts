import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openMemoryDatabase } from "../../src/harness/memory/db/database.js";
import {
  cleanupEvidence,
  persistObservationEvidence,
} from "../../src/harness/memory/evidence.js";
import { ActivityRepository } from "../../src/harness/memory/activity/repository.js";
import type { ActivityOutput } from "../../src/harness/memory/activity/types.js";
import type { ScreenObservation } from "../../src/plugins/screen-observation/types.js";
import { testMemoryConfig } from "./test-config.js";

const memory = testMemoryConfig();

const observation: ScreenObservation = {
  schemaVersion: 1,
  id: "observation-1",
  occurredAt: "2026-08-04T10:00:01.000Z",
  capturedAt: "2026-08-04T10:00:01.100Z",
  trigger: { type: "focusedWindowChanged" },
  window: { processIdentifier: 42, applicationName: "Safari" },
  screenshot: {
    status: "complete",
    durationMilliseconds: 1,
    mimeType: "image/jpeg",
    dataBase64: "raw-screen-evidence",
  },
  accessibility: { status: "complete", durationMilliseconds: 1 },
  visibleText: "Memory notes",
  diagnostics: {
    triggerToCaptureMilliseconds: 1,
    screenshotDurationMilliseconds: 1,
    accessibilityDurationMilliseconds: 1,
  },
};

const output: ActivityOutput = {
  activities: [{
    summary: "The user viewed memory notes.",
    sourceIds: ["observation:observation-1"],
    entities: [],
    verbatimEvidence: [],
    scopeHints: [],
  }],
  sourceSummary: "The user viewed memory notes.",
  rawMemory: null,
  scopeHints: [],
};

test("atomically stores raw Observation evidence outside SQLite with private permissions", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-evidence-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const database = openMemoryDatabase(root);
  t.after(() => database.close());
  const repository = new ActivityRepository(database, memory);
  const now = Date.parse("2026-08-04T10:00:02.000Z");

  const evidence = await persistObservationEvidence(root, observation);
  repository.ingestObservation(observation, now, evidence);

  assert.equal((await stat(join(root, evidence.path))).mode & 0o777, 0o600);
  assert.match(await readFile(join(root, evidence.path), "utf8"), /raw-screen-evidence/);
  const row = database.connection.prepare(`
    SELECT projection_json, sidecar_path, sidecar_sha256, sidecar_delete_after
    FROM source_items WHERE id = 'observation:observation-1'
  `).get();
  assert.doesNotMatch(String(row?.projection_json), /raw-screen-evidence/);
  assert.equal(row?.sidecar_path, evidence.path);
  assert.equal(row?.sidecar_sha256, evidence.sha256);
  assert.equal(
    row?.sidecar_delete_after,
    now + memory.evidence.failedRetentionMilliseconds,
  );
});

test("keeps successful evidence for 24 hours and safely cleans it when due", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-evidence-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const database = openMemoryDatabase(root);
  t.after(() => database.close());
  const repository = new ActivityRepository(database, memory);
  const evidence = await persistObservationEvidence(root, observation);
  repository.ingestObservation(observation, 1, evidence);
  const due = Date.parse("2026-08-04T10:01:15.000Z");
  const claim = repository.claimNext({ workerId: "worker", now: due });
  assert.ok(claim);
  const completedAt = due + 5_000;
  repository.complete(claim.jobKey, claim.ownershipToken, output, completedAt);

  const deleteAfter = database.connection.prepare(`
    SELECT sidecar_delete_after FROM source_items WHERE id = 'observation:observation-1'
  `).get()?.sidecar_delete_after;
  assert.equal(
    deleteAfter,
    completedAt + memory.evidence.successRetentionMilliseconds,
  );
  assert.equal(await cleanupEvidence(
    database,
    root,
    memory.evidence,
    Number(deleteAfter) - 1,
  ), 0);
  await access(join(root, evidence.path));
  assert.equal(await cleanupEvidence(
    database,
    root,
    memory.evidence,
    Number(deleteAfter),
  ), 1);
  await assert.rejects(access(join(root, evidence.path)));
  assert.deepEqual({ ...database.connection.prepare(`
    SELECT sidecar_path, sidecar_sha256, sidecar_delete_after
    FROM source_items WHERE id = 'observation:observation-1'
  `).get() }, {
    sidecar_path: null,
    sidecar_sha256: null,
    sidecar_delete_after: null,
  });
});

test("keeps failed evidence for seven days and removes abandoned temp files", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-evidence-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const database = openMemoryDatabase(root);
  t.after(() => database.close());
  const repository = new ActivityRepository(database, memory);
  const evidence = await persistObservationEvidence(root, observation);
  repository.ingestObservation(observation, 1, evidence);
  const due = Date.parse("2026-08-04T10:01:15.000Z");
  const claim = repository.claimNext({ workerId: "worker", now: due });
  assert.ok(claim);
  const failedAt = due + 5_000;
  repository.fail(claim.jobKey, claim.ownershipToken, "model failed", failedAt);
  assert.equal(database.connection.prepare(`
    SELECT sidecar_delete_after FROM source_items WHERE id = 'observation:observation-1'
  `).get()?.sidecar_delete_after,
  failedAt + memory.evidence.failedRetentionMilliseconds);

  const temp = join(root, "evidence", "observations", ".abandoned.tmp");
  const orphan = join(root, "evidence", "observations", "orphan.json");
  await writeFile(temp, "partial", { mode: 0o600 });
  await writeFile(orphan, "orphan", { mode: 0o600 });
  const abandonedAt = new Date(
    failedAt - memory.evidence.abandonedGraceMilliseconds - 1,
  );
  await utimes(temp, abandonedAt, abandonedAt);
  await utimes(orphan, abandonedAt, abandonedAt);
  await cleanupEvidence(database, root, memory.evidence, failedAt);
  await assert.rejects(access(temp));
  await assert.rejects(access(orphan));
});

test("does not treat recently created unreferenced files as abandoned", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-evidence-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const database = openMemoryDatabase(root);
  t.after(() => database.close());
  const directory = join(root, "evidence", "observations");
  await mkdir(directory, { recursive: true });
  const temp = join(directory, ".active.tmp");
  const orphan = join(directory, "not-yet-referenced.json");
  await writeFile(temp, "partial", { mode: 0o600 });
  await writeFile(orphan, "pending", { mode: 0o600 });
  const now = Date.now();

  await cleanupEvidence(database, root, memory.evidence, now);
  await access(temp);
  await access(orphan);
  await cleanupEvidence(
    database,
    root,
    memory.evidence,
    now + memory.evidence.abandonedGraceMilliseconds + 1_000,
  );
  await assert.rejects(access(temp));
  await assert.rejects(access(orphan));
});
