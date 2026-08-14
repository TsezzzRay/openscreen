import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import test from "node:test";

import { moduleSpecifiersForSources } from "../import-boundary.js";

const captureRoot = resolve("agent/src/capture");

test("Capture source does not import Agent, pi, application, transport, or root protocol modules", () => {
  const violations: string[] = [];
  const sources = readdirSync(captureRoot, { recursive: true })
    .filter((entry): entry is string =>
      typeof entry === "string" && extname(entry) === ".ts"
    )
    .map((entry) => {
      const path = join(captureRoot, entry);
      return { fileName: path, source: readFileSync(path, "utf8") };
    });
  const specifiers = moduleSpecifiersForSources(sources);
  for (const { fileName } of sources) {
    for (const specifier of specifiers.get(fileName) ?? []) {
      if (
        specifier.includes("/agent/") ||
        specifier.includes("pi-agent-core") ||
        specifier.includes("pi-ai") ||
        specifier.includes("application") ||
        specifier.includes("transport") ||
        /(?:^|\/)\.\.\/(?:\.\.\/)*(?:protocol|types|config)\.js$/.test(specifier)
      ) {
        violations.push(`${relative(captureRoot, fileName)}: ${specifier}`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

test("Capture API contains neutral DTOs and has no internal imports", () => {
  const source = readFileSync(join(captureRoot, "api.ts"), "utf8");

  assert.doesNotMatch(source, /^import\s/m);
  assert.doesNotMatch(source, /AgentPrompt|pi-agent-core|pi-ai|provider/i);
  assert.match(source, /export type CapturedImage/);
  assert.match(source, /export type CapturedContext/);
  assert.match(source, /export interface CaptureService/);
});

test("Capture diagnostics contain no application-owned chat events", () => {
  const diagnostics = readFileSync(join(captureRoot, "diagnostics.ts"), "utf8");

  assert.doesNotMatch(diagnostics, /chat\.context_attached|contextMode/);
});

test("Capture source groups artifacts, accessibility projection, and native integration by responsibility", () => {
  assert.deepEqual(
    readdirSync(captureRoot).sort(),
    [
      "accessibility-projector.ts",
      "api.ts",
      "artifact-store.ts",
      "artifact.ts",
      "background-capture.ts",
      "config.ts",
      "context-projector.ts",
      "coordinator.ts",
      "dedupe.ts",
      "diagnostics.ts",
      "native",
      "observation-resolver.ts",
      "observation.ts",
      "scheduler.ts",
      "service.ts",
    ],
  );
  assert.deepEqual(
    readdirSync(join(captureRoot, "native")).sort(),
    ["helper-client.ts", "protocol.ts"],
  );
});

test("Capture local module graph is acyclic", () => {
  const sources = readdirSync(captureRoot, { recursive: true })
    .filter((entry): entry is string =>
      typeof entry === "string" && extname(entry) === ".ts"
    )
    .map((entry) => {
      const fileName = join(captureRoot, entry);
      return { fileName, source: readFileSync(fileName, "utf8") };
    });
  const sourceNames = new Set(sources.map(({ fileName }) => fileName));
  const specifiers = moduleSpecifiersForSources(sources);
  const graph = new Map<string, string[]>();
  for (const { fileName } of sources) {
    const localDependencies = (specifiers.get(fileName) ?? [])
      .filter((specifier) => specifier.startsWith("."))
      .map((specifier) =>
        resolve(dirname(fileName), specifier.replace(/\.js$/, ".ts"))
      )
      .filter((dependency) => sourceNames.has(dependency));
    graph.set(fileName, localDependencies);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (fileName: string, path: string[]) => {
    if (visiting.has(fileName)) {
      const cycleStart = path.indexOf(fileName);
      assert.fail(
        `Capture import cycle: ${[...path.slice(cycleStart), fileName]
          .map((entry) => relative(captureRoot, entry))
          .join(" -> ")}`,
      );
    }
    if (visited.has(fileName)) return;
    visiting.add(fileName);
    for (const dependency of graph.get(fileName) ?? []) {
      visit(dependency, [...path, fileName]);
    }
    visiting.delete(fileName);
    visited.add(fileName);
  };
  for (const { fileName } of sources) visit(fileName, []);
});
