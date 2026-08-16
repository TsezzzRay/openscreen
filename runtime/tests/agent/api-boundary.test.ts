import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import test from "node:test";

import { moduleSpecifiersForSources } from "../import-boundary.js";

const agentRoot = resolve("runtime/src/agent");

function sourcesUnder(root: string) {
  return readdirSync(root, { recursive: true })
    .filter((entry): entry is string =>
      typeof entry === "string" && extname(entry) === ".ts"
    )
    .map((entry) => {
      const fileName = join(root, entry);
      return { fileName, source: readFileSync(fileName, "utf8") };
    });
}

test("keeps the public Agent API independent from runtime and app adapters", () => {
  const apiPath = join(agentRoot, "api.ts");
  assert.equal(existsSync(apiPath), true, "Agent API boundary must exist");

  const source = readFileSync(apiPath, "utf8");
  const imports = moduleSpecifiersForSources([{ fileName: apiPath, source }])
    .get(apiPath) ?? [];

  for (const specifier of imports) {
    assert.doesNotMatch(
      specifier,
      /(?:pi-agent-core|pi-ai|capture|application|transport|protocol)/,
    );
  }
});

test("keeps every recursive pi adapter and tool independent from app modules", () => {
  const piRoot = join(agentRoot, "pi");
  assert.equal(existsSync(piRoot), true, "pi adapter directory must exist");

  const sources = sourcesUnder(piRoot);
  const specifiers = moduleSpecifiersForSources(sources);
  const violations: string[] = [];
  for (const { fileName } of sources) {
    for (const specifier of specifiers.get(fileName) ?? []) {
      if (/(?:capture|application|transport)/.test(specifier)) {
        violations.push(`${relative(piRoot, fileName)}: ${specifier}`);
      }
    }
  }

  assert.deepEqual(violations, []);
  assert.equal(
    sources.some(({ fileName }) =>
      fileName.endsWith("/tools/create-agent-tools.ts")
    ),
    true,
    "recursive scan must include agent/pi/tools",
  );
});

test("keeps the pi adapter split only at its stateful responsibility boundaries", () => {
  const piRoot = join(agentRoot, "pi");

  assert.deepEqual(readdirSync(piRoot).sort(), [
    "memory-citation.ts",
    "prompt-runner.ts",
    "service.ts",
    "session-projection.ts",
    "session-runtime.ts",
    "tools",
  ]);
});

test("keeps model enumeration and switching out of the public Agent contract", () => {
  const files = [
    join(agentRoot, "api.ts"),
    resolve("runtime/src/application/api.ts"),
    resolve("runtime/src/application/runtime.ts"),
    resolve("runtime/src/transport/jsonl-codec.ts"),
  ];

  for (const file of files) {
    const source = readFileSync(file, "utf8");
    assert.doesNotMatch(
      source,
      /(?:AgentModelRef|AgentModelSummary|ProductModelRef|ProductModelSummary|listModels|setModel|list_models|set_model)/,
      relative(resolve("runtime/src"), file),
    );
  }
});

test("keeps branch navigation, historical replay, and tool switching out of the product contract", () => {
  const files = [
    join(agentRoot, "api.ts"),
    resolve("runtime/src/application/api.ts"),
    resolve("runtime/src/application/runtime.ts"),
    resolve("runtime/src/transport/jsonl-codec.ts"),
  ];
  const forbidden =
    /(?:AgentTree|ProductTree|Navigation|navigate|setActiveTools|set_active_tools|reuseImagesFromMessageId|sourceMessageId|activeTools|availableTools|session-state-uncertain)/;

  for (const file of files) {
    assert.doesNotMatch(
      readFileSync(file, "utf8"),
      forbidden,
      relative(resolve("runtime/src"), file),
    );
  }
});
