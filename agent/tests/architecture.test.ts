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
    "harness/memory/processor.ts",
    "harness/memory/store.ts",
    "harness/memory/lock.ts",
    "harness/memory/types.ts",
    "harness/memory/timeline/processor.ts",
    "harness/memory/timeline/store.ts",
    "harness/memory/timeline/types.ts",
  ];
  const removedPaths = [
    "main.ts",
    "chat",
    "activity",
    "session",
    "harness/memory/validation.ts",
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

  assert.doesNotMatch(protocol, /harness\//);
  assert.doesNotMatch(runner, /protocol\.js/);
  assert.doesNotMatch(rootTypes, /export type AgentRun(?:Step|ToolResult)?\b/);
});
