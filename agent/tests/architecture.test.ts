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
    "model-token-count.ts",
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
    "harness/memory/chronicle/model-projection.ts",
    "harness/memory/chronicle/processor.ts",
    "harness/memory/chronicle/repository.ts",
    "harness/memory/chronicle/summarizer.ts",
    "harness/memory/turn-memory/model-projection.ts",
    "harness/memory/turn-memory/processor.ts",
    "harness/memory/turn-memory/repository.ts",
    "harness/memory/turn-memory/extractor.ts",
    "harness/memory/shared/request-budget.ts",
    "harness/memory/shared/structured-output.ts",
    "harness/memory/consolidate/processor.ts",
    "harness/memory/consolidate/repository.ts",
    "harness/memory/consolidate/publication.ts",
    "harness/memory/consolidate/workspace.ts",
    "harness/memory/worker/client.ts",
    "harness/memory/worker/runtime.ts",
    "harness/memory/worker/thread.ts",
    "extensions/screen-observation/extension.ts",
    "extensions/screen-observation/types.ts",
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
    "harness/memory/activity/projection.ts",
    "harness/memory/activity",
    "harness/memory/consolidate/jobs.ts",
    "harness/memory/stage1",
    "harness/memory/phase2",
    "harness/memory/processor.ts",
    "harness/memory/store.ts",
    "harness/memory/lock.ts",
    "contracts",
    "plugins",
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
  const observationExtension = readFileSync(
    resolve(sourceRoot, "extensions/screen-observation/extension.ts"),
    "utf8",
  );
  const chronicleProjection = readFileSync(
    resolve(sourceRoot, "harness/memory/chronicle/model-projection.ts"),
    "utf8",
  );
  const chronicleSummarizer = readFileSync(
    resolve(sourceRoot, "harness/memory/chronicle/summarizer.ts"),
    "utf8",
  );
  const turnMemoryProjection = readFileSync(
    resolve(sourceRoot, "harness/memory/turn-memory/model-projection.ts"),
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
  assert.doesNotMatch(observationExtension, /harness\/(?:session|memory)/);
  assert.doesNotMatch(observationExtension, /AgentTool/);
  assert.match(
    observationExtension,
    /export type ScreenObservationExtensionOptions\b/,
  );
  assert.match(chronicleProjection, /extensions\/screen-observation\/types\.js/);
  assert.match(chronicleProjection, /export function projectChronicleObservation\b/);
  assert.doesNotMatch(chronicleProjection, /dataBase64|turn-memory|session\//);
  assert.doesNotMatch(chronicleSummarizer, /raw_memory|TurnMemory/);
  assert.doesNotMatch(turnMemoryProjection, /screen-observation|Chronicle/);
  assert.match(memoryTypes, /export type LongTermMemory\b/);
  assert.match(
    memoryTypes,
    /evidenceSourceIds: \[string, \.\.\.string\[\]\]/,
  );
  assert.doesNotMatch(memoryTypes, /export type MemoryItem\b/);
  assert.match(retrievalTypes, /export type RetrieveMemoryArguments\b/);
  assert.doesNotMatch(retrievalTypes, /AgentTool/);
});

test("keeps screenshot implementation inside ObservationHelper", () => {
  const packageManifest = readFileSync(resolve("Package.swift"), "utf8");
  const helperCaptureRoot = resolve("Sources/ObservationHelper/Capture");
  const helperSources = [
    "CaptureEngine.swift",
    "Target.swift",
    "Windows.swift",
    "WindowResolver.swift",
    "../Monitoring/VisualSource.swift",
  ].map((path) => readFileSync(resolve(helperCaptureRoot, path), "utf8"));

  assert.equal(existsSync(resolve("Sources/CaptureCore")), false);
  assert.equal(existsSync(resolve(helperCaptureRoot, "Target.swift")), true);
  assert.equal(existsSync(resolve(helperCaptureRoot, "Windows.swift")), true);
  assert.doesNotMatch(packageManifest, /CaptureCore/);
  for (const source of helperSources) {
    assert.doesNotMatch(source, /import CaptureCore/);
  }
});

test("shares one window identity key across observation scheduling and dedupe", () => {
  const service = readFileSync(
    resolve("agent/src/extensions/screen-observation/service.ts"),
    "utf8",
  );

  assert.match(service, /import \{\s*windowKey\s*\} from "\.\/dedupe\.js";/);
  assert.match(service, /windowKey\(signal\.window\)/);
  assert.doesNotMatch(service, /function windowKey\(/);
});
