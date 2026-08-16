import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import test from "node:test";

import { moduleSpecifiersForSources } from "../import-boundary.js";

test("Transport imports only Application API and Node standard libraries", () => {
  const root = resolve("runtime/src/transport");
  const sources = readdirSync(root, { recursive: true })
    .filter((entry): entry is string =>
      typeof entry === "string" && extname(entry) === ".ts"
    )
    .map((entry) => {
      const fileName = join(root, entry);
      return { fileName, source: readFileSync(fileName, "utf8") };
    });
  const specifiers = moduleSpecifiersForSources(sources);
  const violations: string[] = [];
  for (const { fileName } of sources) {
    for (const specifier of specifiers.get(fileName) ?? []) {
      if (
        !specifier.startsWith("node:") &&
        specifier !== "../application/api.js" &&
        !specifier.startsWith("./")
      ) {
        violations.push(`${relative(root, fileName)}: ${specifier}`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

test("Transport separates JSONL codec from stream serving", () => {
  const root = resolve("runtime/src/transport");
  assert.deepEqual(
    readdirSync(root).sort(),
    ["jsonl-codec.ts", "jsonl-server.ts"],
  );
  const codec = readFileSync(join(root, "jsonl-codec.ts"), "utf8");
  assert.doesNotMatch(codec, /node:(?:readline|stream)/);
  assert.doesNotMatch(codec, /ApplicationHandler|serveJsonl/);
});
