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

const sourceRoot = resolve("runtime/src");
const testsRoot = resolve("runtime/tests");

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
    "desktop",
    "main.ts",
    "memory",
    "runtime-config.ts",
    "security",
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
  const legacyProcessEntry = ["runtime/dist", "process.js"].join("/");
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

test("keeps Agent, Capture, Memory, Application, and Transport boundaries strict", () => {
  const sources = sourcesUnder(sourceRoot);
  const specifiers = moduleSpecifiersForSources(sources);
  const violations: string[] = [];

  for (const { fileName } of sources) {
    const path = relative(sourceRoot, fileName);
    for (const specifier of specifiers.get(fileName) ?? []) {
      const target = localTypeScriptTarget(fileName, specifier);
      const targetPath = target === undefined
        ? undefined
        : relative(sourceRoot, target);
      if (
        path.startsWith("agent/") &&
        targetPath !== undefined &&
        /^(?:capture|memory|application|transport)\//.test(targetPath)
      ) {
        violations.push(`${path}: ${specifier}`);
      }
      if (
        path.startsWith("capture/") &&
        ((targetPath !== undefined &&
          /^(?:agent|memory|application|transport)\//.test(targetPath)) ||
          specifier.includes("pi-agent-core") ||
          specifier.includes("pi-ai"))
      ) {
        violations.push(`${path}: ${specifier}`);
      }
      if (
        path.startsWith("memory/") &&
        targetPath !== undefined &&
        /^(?:agent|capture|application|transport)\//.test(targetPath)
      ) {
        violations.push(`${path}: ${specifier}`);
      }
      if (
        path.startsWith("application/") &&
        !path.endsWith("api.ts") &&
        specifier.startsWith("..") &&
        targetPath !== "agent/api.ts" &&
        targetPath !== "capture/api.ts"
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
      imports.some((item) => item.endsWith("capture/native/service.js")) &&
      imports.some((item) => item.endsWith("application/runtime.js")) &&
      imports.some((item) => item.endsWith("transport/jsonl-server.js"))
    ) {
      composers.push(relative(sourceRoot, fileName));
    }
  }

  assert.deepEqual(composers, ["main.ts"]);
});

test("main owns the same-process desktop adapter used for window observation", () => {
  const main = readFileSync(join(sourceRoot, "main.ts"), "utf8");
  assert.match(main, /createCuaDesktopDriver\(nativeFocusHelperPath\(\)\)/);
  assert.match(main, /await desktopDriver\.close\(\)/);
  assert.doesNotMatch(main, /from "@trycua\/cua-driver"/);
  const adapter = readFileSync(join(sourceRoot, "desktop/cua-driver.ts"), "utf8");
  assert.match(adapter, /import \{[^}]*CuaDriver[^}]*\} from "@trycua\/cua-driver"/);
  assert.match(adapter, /CuaDriver\.create\(undefined\)/);
  assert.match(adapter, /desktopWindows: async/);
  assert.match(adapter, /listWindows\(\{ onScreenOnly: true \}\)/);
  assert.match(adapter, /desktopWindowState: async/);
  assert.match(adapter, /getWindowState\(/);
  assert.match(adapter, /includeScreenshot: true/);
  assert.match(adapter, /maxImageDimension: 1_200/);
});

test("desktop adapter sends approved clicks to exact background Cua Driver targets", () => {
  const main = readFileSync(join(sourceRoot, "desktop/cua-driver.ts"), "utf8");
  assert.match(main, /desktopClick: async/);
  assert.match(main, /ActionTarget\.Window\.new\(\{ pid, windowId \}\)/);
  assert.match(main, /ClickPosition\.Element\.new/);
  assert.match(main, /ClickPosition\.Coordinates\.new/);
  assert.match(main, /InputDeliveryMode\.Background/);
  assert.doesNotMatch(main, /InputDeliveryMode\.Foreground/);
  assert.match(main, /desktopDriver\.click\(/);
});

test("desktop adapter sends approved window-local scrolls to the Cua Driver", () => {
  const main = readFileSync(join(sourceRoot, "desktop/cua-driver.ts"), "utf8");
  assert.match(main, /desktopScroll: async/);
  assert.match(main, /desktopDriver\.scroll\(/);
  assert.match(main, /ActionTarget\.Window\.new\(\{ pid, windowId \}\)/);
  assert.match(main, /ScrollDirection\./);
  assert.match(main, /ScrollBy\./);
  assert.match(main, /BigInt\(amount\)/);
});

test("desktop execution uncertainty preserves the exact tool in session audit", () => {
  const runner = readFileSync(join(sourceRoot, "agent/pi/prompt-runner.ts"), "utf8");
  assert.match(runner, /tool: event\.type === "security-host-execution-uncertain" \? "bash" : event\.tool/);
});

test("ships no Swift target, including the retired capture backends", () => {
  // The frontend is Electron. This subsumes the earlier guard against
  // resurrecting the ObservationHelper and CaptureCore capture backends, which
  // only ever existed as Swift targets.
  // Match the actual root spelling: on case-insensitive macOS filesystems,
  // existsSync("Tests") also matches the supported lowercase integration tests.
  const rootEntries = new Set(readdirSync(resolve()));
  for (const path of [
    "Package.swift",
    "Sources",
    "Tests",
    "Sources/ObservationHelper",
    "Sources/CaptureCore",
  ]) {
    assert.equal(rootEntries.has(path.split("/")[0]!) && existsSync(resolve(path)), false,
      `${path} should not exist`);
  }
});
