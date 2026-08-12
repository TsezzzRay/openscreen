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
import { ChronicleRepository } from "../../src/harness/memory/chronicle/repository.js";
import type { ChronicleSummary } from "../../src/harness/memory/chronicle/types.js";
import type { ScreenObservation } from "../../src/extensions/screen-observation/types.js";
import { testMemoryConfig } from "./test-config.js";

const memory = testMemoryConfig();
const screenshotBytes = Buffer.from("raw-screen-evidence");

const observation: ScreenObservation = {
  schemaVersion: 1,
  id: "observation-1",
  captureId: "capture-1",
  activityRevision: 1,
  occurredAt: "2026-08-04T10:00:01.000Z",
  capturedAt: "2026-08-04T10:00:01.100Z",
  trigger: { type: "focusedWindowChanged" },
  window: { processIdentifier: 42, applicationName: "Safari" },
  screenshot: {
    status: "complete",
    durationMilliseconds: 1,
    mimeType: "image/jpeg",
    dataBase64: screenshotBytes.toString("base64"),
  },
  accessibility: { status: "complete", durationMilliseconds: 1 },
  visibleText: "Memory notes",
  diagnostics: {
    triggerToCaptureMilliseconds: 1,
    screenshotDurationMilliseconds: 1,
    accessibilityDurationMilliseconds: 1,
  },
};

const output: ChronicleSummary = {
  activities: [{
    summary: "The user viewed memory notes.",
    sourceIds: ["observation:observation-1"],
  }],
  sourceSummary: "The user viewed memory notes.",
};

test("atomically splits structured Observation evidence from its JPEG", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-evidence-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const database = openMemoryDatabase(root);
  t.after(() => database.close());
  const repository = new ChronicleRepository(database, memory);
  const now = Date.parse("2026-08-04T10:00:02.000Z");

  const evidence = await persistObservationEvidence(root, observation);
  repository.ingestObservation(observation, now, evidence);

  assert.equal((await stat(join(root, evidence.structured.path))).mode & 0o777, 0o600);
  assert.equal((await stat(join(root, evidence.screenshot!.path))).mode & 0o777, 0o600);
  assert.doesNotMatch(
    await readFile(join(root, evidence.structured.path), "utf8"),
    new RegExp(observation.screenshot.dataBase64!),
  );
  assert.deepEqual(
    await readFile(join(root, evidence.screenshot!.path)),
    screenshotBytes,
  );
  const row = database.connection.prepare(`
    SELECT projection_json, structured_path, structured_sha256,
           screenshot_path, screenshot_sha256,
           structured_delete_after, screenshot_delete_after
    FROM chronicle_sources WHERE id = 'observation:observation-1'
  `).get();
  assert.doesNotMatch(String(row?.projection_json), new RegExp(observation.screenshot.dataBase64!));
  assert.equal(row?.structured_path, evidence.structured.path);
  assert.equal(row?.structured_sha256, evidence.structured.sha256);
  assert.equal(row?.screenshot_path, evidence.screenshot?.path);
  assert.equal(row?.screenshot_sha256, evidence.screenshot?.sha256);
  assert.equal(
    row?.structured_delete_after,
    now + memory.evidence.failedRetentionMilliseconds,
  );
  assert.equal(
    row?.screenshot_delete_after,
    now + memory.evidence.screenshotRetentionMilliseconds,
  );
});

test("keeps successful evidence for 24 hours and safely cleans it when due", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-evidence-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const database = openMemoryDatabase(root);
  t.after(() => database.close());
  const repository = new ChronicleRepository(database, memory);
  const evidence = await persistObservationEvidence(root, observation);
  repository.ingestObservation(observation, 1, evidence);
  const due = Date.parse("2026-08-04T10:01:15.000Z");
  const claim = repository.claimNext({ workerId: "worker", now: due });
  assert.ok(claim);
  const completedAt = due + 5_000;
  repository.complete(claim, output, completedAt);

  const deleteAfter = database.connection.prepare(`
    SELECT structured_delete_after FROM chronicle_sources
    WHERE id = 'observation:observation-1'
  `).get()?.structured_delete_after;
  assert.equal(
    deleteAfter,
    completedAt + memory.evidence.successRetentionMilliseconds,
  );
  assert.equal(await cleanupEvidence(
    database,
    root,
    memory.evidence,
    Number(deleteAfter) - 1,
  ), 1);
  await access(join(root, evidence.structured.path));
  await assert.rejects(access(join(root, evidence.screenshot!.path)));
  assert.equal(await cleanupEvidence(
    database,
    root,
    memory.evidence,
    Number(deleteAfter),
  ), 1);
  await assert.rejects(access(join(root, evidence.structured.path)));
  assert.deepEqual({ ...database.connection.prepare(`
    SELECT structured_path, structured_sha256, structured_delete_after
    FROM chronicle_sources WHERE id = 'observation:observation-1'
  `).get() }, {
    structured_path: null,
    structured_sha256: null,
    structured_delete_after: null,
  });
});

test("keeps failed evidence for seven days and removes abandoned temp files", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-evidence-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const database = openMemoryDatabase(root);
  t.after(() => database.close());
  const repository = new ChronicleRepository(database, memory);
  const evidence = await persistObservationEvidence(root, observation);
  repository.ingestObservation(observation, 1, evidence);
  const due = Date.parse("2026-08-04T10:01:15.000Z");
  const claim = repository.claimNext({ workerId: "worker", now: due });
  assert.ok(claim);
  const failedAt = due + 5_000;
  repository.fail(claim, "model failed", failedAt);
  assert.equal(database.connection.prepare(`
    SELECT structured_delete_after FROM chronicle_sources
    WHERE id = 'observation:observation-1'
  `).get()?.structured_delete_after,
  failedAt + memory.evidence.failedRetentionMilliseconds);

  const temp = join(root, "evidence", "structured", ".abandoned.tmp");
  const orphan = join(root, "evidence", "structured", "orphan.json");
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
  const directory = join(root, "evidence", "structured");
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

test("expires screenshots after 24 hours independently of failed structured evidence", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-evidence-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const database = openMemoryDatabase(root);
  t.after(() => database.close());
  const repository = new ChronicleRepository(database, memory);
  const ingestedAt = Date.parse("2026-08-04T10:00:02.000Z");
  const evidence = await persistObservationEvidence(root, observation);
  repository.ingestObservation(observation, ingestedAt, evidence);

  assert.equal(await cleanupEvidence(
    database,
    root,
    memory.evidence,
    ingestedAt + memory.evidence.screenshotRetentionMilliseconds,
  ), 1);
  await assert.rejects(access(join(root, evidence.screenshot!.path)));
  await access(join(root, evidence.structured.path));
  assert.deepEqual({ ...database.connection.prepare(`
    SELECT structured_path, screenshot_path, screenshot_delete_after
    FROM chronicle_sources WHERE id = 'observation:observation-1'
  `).get() }, {
    structured_path: evidence.structured.path,
    screenshot_path: null,
    screenshot_delete_after: null,
  });
});

test("evicts the oldest referenced evidence when the capacity limit is exceeded", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-evidence-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const database = openMemoryDatabase(root);
  t.after(() => database.close());
  const repository = new ChronicleRepository(database, memory);
  const first = await persistObservationEvidence(root, observation);
  repository.ingestObservation(observation, 1, first);
  const nextObservation = {
    ...observation,
    id: "observation-2",
    occurredAt: "2026-08-04T10:00:02.000Z",
    capturedAt: "2026-08-04T10:00:02.100Z",
  };
  const second = await persistObservationEvidence(root, nextObservation);
  repository.ingestObservation(nextObservation, 2, second);
  const secondBytes = (await stat(join(root, second.structured.path))).size +
    (await stat(join(root, second.screenshot!.path))).size;

  const deleted = await cleanupEvidence(database, root, {
    ...memory.evidence,
    maxBytes: secondBytes,
  }, 3);

  assert.ok(deleted >= 2);
  await assert.rejects(access(join(root, first.structured.path)));
  await assert.rejects(access(join(root, first.screenshot!.path)));
  await access(join(root, second.structured.path));
  await access(join(root, second.screenshot!.path));
});
