import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import test from "node:test";

import { moduleSpecifiersForSources } from "../import-boundary.js";

const sourceRoot = resolve("runtime/src");

function sourcesUnder(relativeRoot: string) {
  const root = join(sourceRoot, relativeRoot);
  return readdirSync(root, { recursive: true })
    .filter((entry): entry is string =>
      typeof entry === "string" && extname(entry) === ".ts"
    )
    .map((entry) => {
      const fileName = join(root, entry);
      return { fileName, source: readFileSync(fileName, "utf8") };
    });
}

test("Application API is a standalone product protocol", () => {
  const source = readFileSync(join(sourceRoot, "application/api.ts"), "utf8");
  const specifiers = moduleSpecifiersForSources([
    { fileName: "application/api.ts", source },
  ]).get("application/api.ts") ?? [];

  assert.deepEqual(specifiers, []);
  assert.doesNotMatch(source, /AgentService|CaptureService|pi-agent|Transport/);
});

test("Application implementation imports only public Agent and Capture APIs", () => {
  const sources = sourcesUnder("application");
  const specifiers = moduleSpecifiersForSources(sources);
  const violations: string[] = [];
  for (const { fileName } of sources) {
    if (fileName.endsWith("/api.ts")) continue;
    for (const specifier of specifiers.get(fileName) ?? []) {
      if (
        specifier.includes("agent/pi") ||
        specifier.includes("capture/") && !specifier.endsWith("capture/api.js") ||
        specifier.includes("pi-agent-core") ||
        specifier.includes("pi-ai") ||
        specifier.includes("transport") ||
        specifier.includes("harness/") ||
        specifier.includes("protocol")
      ) {
        violations.push(`${relative(sourceRoot, fileName)}: ${specifier}`);
      }
    }
  }
  assert.deepEqual(violations, []);
});
