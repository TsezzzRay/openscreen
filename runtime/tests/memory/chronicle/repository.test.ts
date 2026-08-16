import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openMemoryDatabase } from "../../../src/memory/database.js";
import { projectPendingMemoryArtifacts } from "../../../src/memory/artifact-projector.js";
import { ChronicleRepository } from "../../../src/memory/chronicle/repository.js";
import { parseChronicleSummary } from "../../../src/memory/chronicle/summary-schema.js";
import { projectChronicleFrame } from "../../../src/memory/chronicle/model-projection.js";
import type { ChronicleFrameInput } from "../../../src/memory/chronicle/types.js";

const policy = {
  maxInputTokens: 8_000,
  maxOutputTokens: 2_000,
  windowMilliseconds: 60_000,
  graceMilliseconds: 15_000,
  maxSourcesPerRequest: 10,
  worker: {
    leaseMilliseconds: 60_000,
    retryDelayMilliseconds: 1_000,
    maxAttempts: 3,
  },
};

function frame(id: string, capturedAt: string, monitorKey = "1"): ChronicleFrameInput {
  return {
    sourceId: `screenpipe-frame:[\"generation-1\",\"${id}\"]`,
    generationId: "generation-1",
    frameId: id,
    monitorKey,
    deviceName: "Built-in Display",
    capturedAt,
    trigger: "periodic",
    application: "Safari",
    windowTitle: "OpenScreen",
    url: "https://example.test/chronicle",
    visibleText: `Frame ${id}`,
  };
}

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "openscreen-chronicle-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const database = openMemoryDatabase(root);
  t.after(() => database.close());
  return { database, repository: new ChronicleRepository(database, policy) };
}

test("projects code-owned frame identity without its image path", () => {
  const projection = projectChronicleFrame(frame("7", "2026-08-15T10:00:10.000Z"));
  assert.deepEqual(projection, {
    type: "screenpipe_frame",
    sourceId: "screenpipe-frame:[\"generation-1\",\"7\"]",
    generationId: "generation-1",
    frameId: "7",
    monitorKey: "1",
    deviceName: "Built-in Display",
    capturedAt: "2026-08-15T10:00:10.000Z",
    trigger: "periodic",
    application: "Safari",
    windowTitle: "OpenScreen",
    url: "https://example.test/chronicle",
    visibleText: "Frame 7",
  });
  assert.doesNotMatch(JSON.stringify(projection), /imagePath|private/);
});

test("rejects Chronicle summaries that omit, duplicate, or invent source frames", () => {
  const expected = new Set(["a", "b"]);
  assert.deepEqual(parseChronicleSummary({
    activities: [
      { summary: "Viewed two displays", source_frame_ids: ["a", "b"], application: null, window_title: null },
    ],
    source_summary: "Two display frames were observed.",
  }, expected).activities[0]?.sourceFrameIds, ["a", "b"]);
  for (const ids of [["a"], ["a", "a"], ["a", "missing"]]) {
    assert.throws(() => parseChronicleSummary({
      activities: [{ summary: "Invalid", source_frame_ids: ids, application: null, window_title: null }],
      source_summary: "Invalid",
    }, expected), /Chronicle (output is missing|returned source)/);
  }
});

test("keeps same-name monitors distinct, requeues late sources, and fences the old owner", async (t) => {
  const { database, repository } = await fixture(t);
  const first = frame("1", "2026-08-15T10:00:10.000Z", "1");
  const second = frame("2", "2026-08-15T10:00:40.000Z", "2");
  const at = Date.parse("2026-08-15T10:01:15.000Z");
  assert.equal(repository.ingest(first, at).duplicate, false);
  assert.equal(repository.ingest(first, at).duplicate, true);
  const claim = repository.claimNext({ workerId: "worker-1", now: at });
  assert.ok(claim);
  assert.equal(repository.ingest(second, at + 1).sourceGeneration, claim.sourceGeneration + 1);
  assert.equal(repository.heartbeat(claim, at + 2), false);
  assert.throws(() => repository.complete(claim, {
    activities: [{ summary: "Old", sourceFrameIds: [first.sourceId] }],
    sourceSummary: "Old",
  }, at + 3), /ownership lost/i);
  const replacement = repository.claimNext({ workerId: "worker-2", now: at + 4 });
  assert.ok(replacement);
  const sources = repository.loadClaimSources(replacement);
  assert.deepEqual(sources.map(({ monitorKey }) => monitorKey), ["1", "2"]);
  repository.complete(replacement, {
    activities: [{
      summary: "Viewed the same named displays.",
      sourceFrameIds: sources.map(({ sourceId }) => sourceId),
      application: "Safari",
      windowTitle: "OpenScreen",
    }],
    sourceSummary: "Two monitor streams were observed.",
  }, at + 5);

  assert.equal(database.connection.prepare("SELECT count(*) AS count FROM chronicle_activities").get()?.count, 1);
  assert.deepEqual({ ...database.connection.prepare(`
    SELECT kind, provenance, supports_success, source_ids_json
    FROM memory_sources
  `).get() }, {
    kind: "chronicle",
    provenance: "passive_screen",
    supports_success: 0,
    source_ids_json: JSON.stringify(sources.map(({ sourceId }) => sourceId)),
  });
  const artifact = database.connection.prepare(`
    SELECT relative_path, content, projected_at FROM memory_artifacts
    WHERE kind = 'chronicle_rollout'
  `).get();
  assert.match(String(artifact?.relative_path), /^rollout_summaries\/chronicle-.*\.md$/);
  assert.equal(artifact?.projected_at, null);
  assert.match(String(artifact?.content), /source_frame_ids:/);
  assert.doesNotMatch(String(artifact?.content), /imagePath|base64|image\.jpg/);
});

test("projects a committed Chronicle artifact through the generic projector", async (t) => {
  const { database, repository } = await fixture(t);
  const source = frame("1", "2026-08-15T10:00:10.000Z");
  const due = Date.parse("2026-08-15T10:01:15.000Z");
  repository.ingest(source, due);
  const claim = repository.claimNext({ workerId: "worker-1", now: due });
  assert.ok(claim);
  repository.complete(claim, {
    activities: [{ summary: "Viewed a page.", sourceFrameIds: [source.sourceId] }],
    sourceSummary: "One source was observed.",
  }, due + 1);
  const root = await mkdtemp(join(tmpdir(), "openscreen-chronicle-artifact-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(await projectPendingMemoryArtifacts(root, repository, due + 2), 1);
  const artifact = database.connection.prepare(`
    SELECT relative_path, projected_at FROM memory_artifacts WHERE kind = 'chronicle_rollout'
  `).get();
  assert.equal(artifact?.projected_at, due + 2);
  assert.match(
    await readFile(join(root, String(artifact?.relative_path)), "utf8"),
    /source_frame_ids:/,
  );
});

test("advances a generation-scoped ingest cursor monotonically", async (t) => {
  const { repository } = await fixture(t);

  assert.equal(repository.generationCursor("generation-1"), 0);
  assert.equal(
    repository.advanceGenerationCursor("generation-1", 0, 12, 100),
    true,
  );
  assert.equal(repository.generationCursor("generation-1"), 12);
  assert.equal(
    repository.advanceGenerationCursor("generation-1", 0, 20, 101),
    false,
  );
  assert.equal(
    repository.advanceGenerationCursor("generation-1", 12, 20, 102),
    true,
  );
  assert.equal(repository.generationCursor("generation-1"), 20);
  assert.equal(repository.generationComplete("generation-1"), false);
  assert.equal(repository.completeGeneration("generation-1", 19, 103), false);
  assert.equal(repository.completeGeneration("generation-1", 20, 104), true);
  assert.equal(repository.generationComplete("generation-1"), true);
  assert.equal(repository.completeGeneration("generation-1", 20, 105), true);
  assert.equal(
    repository.advanceGenerationCursor("generation-1", 20, 21, 106),
    false,
  );
  assert.equal(repository.generationCursor("generation-2"), 0);
  assert.throws(
    () => repository.advanceGenerationCursor("generation-1", 20, 19, 103),
    /cursor/i,
  );
});
