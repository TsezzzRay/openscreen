import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { moduleSpecifiersForSources } from "../../import-boundary.js";

function sourceFiles(root: string): string[] {
  return readdirSync(root).flatMap((entry) => {
    const path = resolve(root, entry);
    return statSync(path).isDirectory()
      ? sourceFiles(path)
      : path.endsWith(".ts")
        ? [path]
        : [];
  });
}

test("pi tools do not import legacy tools or application adapters", () => {
  const root = resolve("agent/src/agent/pi/tools");
  const sources = sourceFiles(root).map((fileName) => ({
    fileName,
    source: readFileSync(fileName, "utf8"),
  }));
  const specifiers = moduleSpecifiersForSources(sources);
  const forbidden = [
    /(^|\/)types(?:\.js)?$/,
    /(^|\/)tools\/(?:registry|executor)(?:\.js)?$/,
    /(?:capture|application|transport|protocol)/i,
    /^node:(?:fs|child_process)(?:\/promises)?$/,
  ];

  for (const { fileName } of sources) {
    for (const specifier of specifiers.get(fileName) ?? []) {
      for (const pattern of forbidden) {
        assert.doesNotMatch(specifier, pattern, fileName);
      }
    }
  }
});

test("keeps every canonical tool in its own focused source file", () => {
  const root = resolve("agent/src/agent/pi/tools");

  assert.deepEqual(readdirSync(root).sort(), [
    "bash.ts",
    "create-agent-tools.ts",
    "edit.ts",
    "find.ts",
    "grep.ts",
    "ls.ts",
    "read.ts",
    "search-support.ts",
    "tool-support.ts",
    "write.ts",
  ]);
});
