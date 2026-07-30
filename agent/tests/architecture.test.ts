import assert from "node:assert/strict";
import { existsSync } from "node:fs";
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
    "harness/session/lock.ts",
    "harness/session/context.ts",
    "harness/session/types.ts",
    "harness/compaction/compact.ts",
    "harness/compaction/summary.ts",
    "harness/memory/processor.ts",
    "harness/memory/store.ts",
    "harness/memory/types.ts",
    "harness/memory/timeline/processor.ts",
    "harness/memory/timeline/store.ts",
    "harness/memory/timeline/types.ts",
  ];
  const legacyPaths = ["main.ts", "chat", "activity", "session"];

  assert.deepEqual(
    expectedFiles.filter((path) => !existsSync(resolve(sourceRoot, path))),
    [],
    "missing files from the approved source layout",
  );
  assert.deepEqual(
    legacyPaths.filter((path) => existsSync(resolve(sourceRoot, path))),
    [],
    "legacy source paths remain",
  );
});
