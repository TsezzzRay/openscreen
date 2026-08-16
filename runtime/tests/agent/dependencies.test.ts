import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

type PackageManifest = {
  engines?: {
    node?: string;
  };
  dependencies?: Record<string, string>;
};

function repositoryPackagePath(): string {
  let current = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = join(current, "package.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) throw new Error("Unable to locate package.json");
    current = parent;
  }
}

test("pins the pi runtime dependency baseline independently of process cwd", () => {
  const manifest = JSON.parse(
    readFileSync(repositoryPackagePath(), "utf8"),
  ) as PackageManifest;
  const dependencies = manifest.dependencies ?? {};

  assert.equal(manifest.engines?.node, ">=22.19.0");
  assert.equal(dependencies["@earendil-works/pi-agent-core"], "0.80.7");
  assert.equal(dependencies["@earendil-works/pi-ai"], "0.80.7");
  assert.equal(dependencies.typebox, "1.1.38");
  assert.equal(dependencies["@vscode/ripgrep"], "^1.18.0");
  assert.equal("openai" in dependencies, false);
});

test("runs every compiled nested Agent test recursively", () => {
  const manifest = JSON.parse(
    readFileSync(repositoryPackagePath(), "utf8"),
  ) as { scripts?: Record<string, string> };

  assert.equal(
    manifest.scripts?.["test:runtime"],
    "npm run build:runtime && npm run build:runtime-tests && node --test \"runtime/dist-test/tests/**/*.test.js\"",
  );
});
