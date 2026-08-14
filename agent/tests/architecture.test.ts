import assert from "node:assert/strict";
import {
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import test from "node:test";

import {
  moduleSpecifiersForSources,
  type ImportBoundarySource,
} from "./import-boundary.js";

const sourceRoot = resolve("agent/src");
const testsRoot = resolve("agent/tests");

function sourcesUnder(root: string): ImportBoundarySource[] {
  return readdirSync(root, { recursive: true })
    .filter((entry): entry is string =>
      typeof entry === "string" && extname(entry) === ".ts"
    )
    .map((entry) => {
      const fileName = join(root, entry);
      return { fileName, source: readFileSync(fileName, "utf8") };
    });
}

function localTypeScriptTarget(fileName: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const target = resolve(dirname(fileName), specifier);
  return target.endsWith(".js") ? `${target.slice(0, -3)}.ts` : target;
}

test("contains only the clean TypeScript production layout", () => {
  const entries = readdirSync(sourceRoot, { withFileTypes: true })
    .map((entry) => entry.name)
    .sort();

  assert.deepEqual(entries, [
    "agent",
    "application",
    "capture",
    "main.ts",
    "runtime-config.ts",
    "transport",
  ]);
});

test("removes every explicitly forbidden legacy production path", () => {
  const forbidden = [
    "config.ts",
    "loop.ts",
    "model-token-count.ts",
    "process.ts",
    "protocol.ts",
    "types.ts",
    "harness",
    "tools",
    "extensions",
  ];

  assert.deepEqual(
    forbidden.filter((entry) => existsSync(join(sourceRoot, entry))),
    [],
  );
});

test("source and tests do not import the deleted backend or direct OpenAI package", () => {
  const sources = [...sourcesUnder(sourceRoot), ...sourcesUnder(testsRoot)];
  const specifiers = moduleSpecifiersForSources(sources);
  const legacyProcessEntry = ["agent/dist", "process.js"].join("/");
  const legacyAttemptCommand = ["record", "attempt"].join("_");
  const forbiddenFiles = new Set([
    "config.ts",
    "loop.ts",
    "model-token-count.ts",
    "process.ts",
    "protocol.ts",
    "types.ts",
  ].map((entry) => join(sourceRoot, entry)));
  const violations: string[] = [];

  for (const { fileName, source } of sources) {
    if (
      source.includes(legacyProcessEntry) ||
      source.includes(legacyAttemptCommand)
    ) {
      violations.push(`${relative(resolve(), fileName)}: legacy runtime protocol`);
    }
    for (const specifier of specifiers.get(fileName) ?? []) {
      const target = localTypeScriptTarget(fileName, specifier);
      if (
        specifier === "openai" ||
        (target !== undefined && forbiddenFiles.has(target)) ||
        (target !== undefined && target.startsWith(`${join(sourceRoot, "harness")}/`)) ||
        (target !== undefined && target.startsWith(`${join(sourceRoot, "tools")}/`))
      ) {
        violations.push(`${relative(resolve(), fileName)}: ${specifier}`);
      }
    }
  }

  assert.deepEqual(violations, []);
});

test("keeps Agent, Capture, Application, and Transport boundaries strict", () => {
  const sources = sourcesUnder(sourceRoot);
  const specifiers = moduleSpecifiersForSources(sources);
  const violations: string[] = [];

  for (const { fileName } of sources) {
    const path = relative(sourceRoot, fileName);
    for (const specifier of specifiers.get(fileName) ?? []) {
      if (
        path.startsWith("agent/") &&
        /(?:capture|application|transport)/.test(specifier)
      ) {
        violations.push(`${path}: ${specifier}`);
      }
      if (
        path.startsWith("capture/") &&
        (/(?:agent|application|transport)/.test(specifier) ||
          specifier.includes("pi-agent-core") ||
          specifier.includes("pi-ai"))
      ) {
        violations.push(`${path}: ${specifier}`);
      }
      if (
        path.startsWith("application/") &&
        !path.endsWith("api.ts") &&
        specifier.startsWith("..") &&
        specifier !== "../agent/api.js" &&
        specifier !== "../capture/api.js"
      ) {
        violations.push(`${path}: ${specifier}`);
      }
      if (
        path.startsWith("transport/") &&
        !specifier.startsWith("node:") &&
        specifier !== "../application/api.js" &&
        !specifier.startsWith("./")
      ) {
        violations.push(`${path}: ${specifier}`);
      }
    }
  }

  assert.deepEqual(violations, []);
});

test("keeps the complete TypeScript production module graph acyclic", () => {
  const sources = sourcesUnder(sourceRoot);
  const sourceNames = new Set(sources.map(({ fileName }) => fileName));
  const specifiers = moduleSpecifiersForSources(sources);
  const graph = new Map(sources.map(({ fileName }) => [
    fileName,
    (specifiers.get(fileName) ?? [])
      .map((specifier) => localTypeScriptTarget(fileName, specifier))
      .filter((target): target is string =>
        target !== undefined && sourceNames.has(target)
      ),
  ]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (fileName: string, path: string[]) => {
    if (visiting.has(fileName)) {
      const start = path.indexOf(fileName);
      assert.fail(
        `Production import cycle: ${[...path.slice(start), fileName]
          .map((entry) => relative(sourceRoot, entry))
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

test("main is the sole concrete composition root", () => {
  const sources = sourcesUnder(sourceRoot);
  const specifiers = moduleSpecifiersForSources(sources);
  const composers: string[] = [];

  for (const { fileName } of sources) {
    const imports = specifiers.get(fileName) ?? [];
    if (
      imports.some((item) => item.includes("agent/pi/")) &&
      imports.some((item) => item.endsWith("capture/service.js")) &&
      imports.some((item) => item.endsWith("application/runtime.js")) &&
      imports.some((item) => item.endsWith("transport/jsonl-server.js"))
    ) {
      composers.push(relative(sourceRoot, fileName));
    }
  }

  assert.deepEqual(composers, ["main.ts"]);
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
    resolve("agent/src/capture/background-capture.ts"),
    "utf8",
  );

  assert.match(service, /import \{\s*windowKey\s*\} from "\.\/dedupe\.js";/);
  assert.match(service, /windowKey\(signal\.window\)/);
  assert.doesNotMatch(service, /function windowKey\(/);
});
