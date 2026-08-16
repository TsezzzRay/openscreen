import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import test from "node:test";

import { moduleSpecifiersForSources } from "../import-boundary.js";

test("main is the only source composing concrete Agent, Capture, Application, and Transport", () => {
  const root = resolve("runtime/src");
  const sources = readdirSync(root, { recursive: true })
    .filter((entry): entry is string =>
      typeof entry === "string" && extname(entry) === ".ts"
    )
    .map((entry) => {
      const fileName = join(root, entry);
      return { fileName, source: readFileSync(fileName, "utf8") };
    });
  const specifiers = moduleSpecifiersForSources(sources);
  const composers: string[] = [];
  for (const { fileName } of sources) {
    const imports = specifiers.get(fileName) ?? [];
    const concreteAgent = imports.some((item) => item.includes("agent/pi/"));
    const concreteCapture = imports.some((item) =>
      item.endsWith("capture/screenpipe/service.js")
    );
    const application = imports.some((item) => item.includes("application/runtime"));
    const transport = imports.some((item) => item.includes("transport/jsonl"));
    if (concreteAgent && concreteCapture && application && transport) {
      composers.push(relative(root, fileName));
    }
  }

  assert.deepEqual(composers, ["main.ts"]);
});

test("main resolves built-in models exactly and contains no legacy runtime imports", () => {
  const source = readFileSync(resolve("runtime/src/main.ts"), "utf8");

  assert.match(
    source,
    /export async function run\(\): Promise<void> \{\s*loadProjectEnvironment\(\);\s*const config = loadApplicationConfig\(\);/,
  );
  assert.match(source, /builtinModels\(/);
  assert.match(source, /getProvider\(config\.agent\.provider\)/);
  assert.match(source, /getModel\(config\.agent\.provider, config\.agent\.model\)/);
  assert.match(source, /new RetryingMemoryLifecycle\(/);
  assert.doesNotMatch(source, /diagnostic\.message/);
  assert.doesNotMatch(source, /OpenAI|harness\/session|harness\/memory|\.\/process|\.\/protocol/);
});

test("main starts transport without awaiting the initial Memory model cycle", () => {
  const source = readFileSync(resolve("runtime/src/main.ts"), "utf8");
  const backgroundCycle = source.indexOf("void memory.runOnce().catch");
  const transport = source.indexOf("await serveJsonl");

  assert.equal(source.includes("await memory.runOnce()"), false);
  assert.notEqual(backgroundCycle, -1);
  assert.equal(backgroundCycle < transport, true);
});
