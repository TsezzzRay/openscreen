import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, test } from "vitest";

const repositoryRoot = process.cwd();

describe("development-only desktop application", () => {
  test("keeps npm run dev while shipping no packaging infrastructure", () => {
    const manifest = JSON.parse(
      readFileSync(resolve(repositoryRoot, "package.json"), "utf8"),
    ) as {
      scripts?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    expect(manifest.scripts?.["dev"]).toBe(
      "npm run build:runtime && electron-vite dev",
    );
    expect(manifest.scripts?.["predev"]).toBe(
      "node app/sign-dev-electron.mjs",
    );
    expect(manifest.scripts).not.toHaveProperty("build:app");
    expect(manifest.scripts).not.toHaveProperty("package:app");
    expect(manifest.devDependencies).not.toHaveProperty("electron-builder");
    expect(existsSync(resolve(repositoryRoot, "electron-builder.yml"))).toBe(false);
    expect(existsSync(resolve(repositoryRoot, "app/sign-dev-electron.mjs"))).toBe(
      true,
    );
    expect(existsSync(resolve(repositoryRoot, "scripts"))).toBe(false);
    expect(existsSync(resolve(repositoryRoot, "scripts/package-app.mjs"))).toBe(false);

    const mainSource = readFileSync(
      resolve(repositoryRoot, "app/src/main/index.ts"),
      "utf8",
    );
    expect(mainSource).not.toMatch(/app\.isPackaged|process\.resourcesPath/);
    expect(mainSource).not.toContain("OPENSCREEN_CONFIG_PATH");

    const rendererEntrySource = readFileSync(
      resolve(repositoryRoot, "app/src/main/renderer-entry.ts"),
      "utf8",
    );
    expect(rendererEntrySource).not.toContain("pathToFileURL");
  });
});
