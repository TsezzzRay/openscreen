import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

test("organizes agent core and harness code by responsibility", () => {
  const sourceRoot = resolve("agent/src");
  const expectedFiles = [
    "process.ts",
    "loop.ts",
    "types.ts",
    "config.ts",
    "protocol.ts",
    "harness/session/runner.ts",
    "harness/session/store.ts",
    "harness/session/events.ts",
    "harness/session/lock.ts",
    "harness/session/context.ts",
    "harness/session/types.ts",
    "harness/compaction/compact.ts",
    "harness/compaction/summary.ts",
    "harness/memory/db/database.ts",
    "harness/memory/db/schema.ts",
    "harness/memory/db/attempts.ts",
    "harness/memory/evidence.ts",
    "harness/memory/types.ts",
    "harness/memory/activity/processor.ts",
    "harness/memory/activity/projection.ts",
    "harness/memory/activity/repository.ts",
    "harness/memory/activity/jobs.ts",
    "harness/memory/activity/outputs.ts",
    "harness/memory/activity/sources.ts",
    "harness/memory/activity/scheduler.ts",
    "harness/memory/consolidate/processor.ts",
    "harness/memory/consolidate/repository.ts",
    "harness/memory/consolidate/publication.ts",
    "harness/memory/consolidate/workspace.ts",
    "harness/memory/worker/client.ts",
    "harness/memory/worker/runtime.ts",
    "harness/memory/worker/thread.ts",
    "plugins/screen-observation/plugin.ts",
    "plugins/screen-observation/types.ts",
    "tools/retrieve-memory/types.ts",
  ];
  const removedPaths = [
    "main.ts",
    "chat",
    "activity",
    "session",
    "screen-observation",
    "harness/memory/validation.ts",
    "harness/memory/timeline",
    "harness/memory/retrieval",
    "harness/memory/database.ts",
    "harness/memory/db/values.ts",
    "harness/memory/activity/intake.ts",
    "harness/memory/consolidate/jobs.ts",
    "harness/memory/stage1",
    "harness/memory/phase2",
    "harness/memory/processor.ts",
    "harness/memory/store.ts",
    "harness/memory/lock.ts",
    "contracts",
  ];

  assert.deepEqual(
    expectedFiles.filter((path) => !existsSync(resolve(sourceRoot, path))),
    [],
    "missing files from the approved source layout",
  );
  assert.deepEqual(
    removedPaths.filter((path) => existsSync(resolve(sourceRoot, path))),
    [],
    "removed source paths remain",
  );
});

test("keeps protocol and harness dependencies pointing inward", () => {
  const sourceRoot = resolve("agent/src");
  const protocol = readFileSync(resolve(sourceRoot, "protocol.ts"), "utf8");
  const runner = readFileSync(
    resolve(sourceRoot, "harness/session/runner.ts"),
    "utf8",
  );
  const rootTypes = readFileSync(resolve(sourceRoot, "types.ts"), "utf8");
  const observationPlugin = readFileSync(
    resolve(sourceRoot, "plugins/screen-observation/plugin.ts"),
    "utf8",
  );
  const activityProjection = readFileSync(
    resolve(sourceRoot, "harness/memory/activity/projection.ts"),
    "utf8",
  );
  const memoryTypes = readFileSync(
    resolve(sourceRoot, "harness/memory/types.ts"),
    "utf8",
  );
  const retrievalTypes = readFileSync(
    resolve(sourceRoot, "tools/retrieve-memory/types.ts"),
    "utf8",
  );

  assert.doesNotMatch(protocol, /harness\//);
  assert.doesNotMatch(runner, /protocol\.js/);
  assert.doesNotMatch(rootTypes, /export type AgentRun(?:Step|ToolResult)?\b/);
  assert.doesNotMatch(observationPlugin, /harness\/(?:session|memory)/);
  assert.doesNotMatch(observationPlugin, /AgentTool/);
  assert.match(
    observationPlugin,
    /export type ScreenObservationPluginOptions\b/,
  );
  assert.match(activityProjection, /plugins\/screen-observation\/types\.js/);
  assert.match(activityProjection, /export function projectObservation\b/);
  assert.doesNotMatch(activityProjection, /dataBase64/);
  assert.match(memoryTypes, /export type LongTermMemory\b/);
  assert.match(
    memoryTypes,
    /evidenceSourceIds: \[string, \.\.\.string\[\]\]/,
  );
  assert.doesNotMatch(memoryTypes, /export type MemoryItem\b/);
  assert.match(retrievalTypes, /export type RetrieveMemoryArguments\b/);
  assert.doesNotMatch(retrievalTypes, /AgentTool/);
});
