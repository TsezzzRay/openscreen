import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { CaptureArtifact } from "../../src/extensions/screen-observation/coordinator.js";
import {
  materializeTurnScreenContext,
  projectModelScreenContext,
  type ModelAccessibilityProjectionDiagnostics,
} from "../../src/extensions/screen-observation/screen-context.js";

function artifact(options?: {
  screenshot?: boolean;
  accessibility?: boolean;
  visibleText?: string;
}): CaptureArtifact {
  const source = {
    kind: "mouseClick" as const,
    occurredAt: "2026-08-07T00:00:00.000Z",
    window: {
      processIdentifier: 100,
      bundleIdentifier: "com.example.Editor",
      applicationName: "Editor",
      windowIdentifier: 7,
      title: "Document",
      frame: { x: 0, y: 0, width: 1_200, height: 800 },
    },
  };
  const hasScreenshot = options?.screenshot ?? true;
  const hasAccessibility = options?.accessibility ?? true;
  return {
    captureId: "capture-1",
    activityRevision: 4,
    completedActivityRevision: 4,
    contentEpoch: 3,
    completedContentEpoch: 3,
    signal: source,
    target: source.window,
    status: hasScreenshot
      ? (hasAccessibility ? "complete" : "screenshot_only")
      : (hasAccessibility ? "ax_only" : "failed"),
    completedAtMilliseconds: 1_000,
    result: {
      capturedAt: "2026-08-07T00:00:00.100Z",
      validation: {
        preflightDurationMilliseconds: 2,
        attestationDurationMilliseconds: 1,
      },
      window: source.window,
      screenshot: hasScreenshot
        ? {
            status: "complete",
            durationMilliseconds: 10,
            mimeType: "image/jpeg",
            dataBase64: Buffer.from("jpeg bytes").toString("base64"),
            width: 100,
            height: 80,
          }
        : {
            status: "permissionDenied",
            durationMilliseconds: 1,
          },
      accessibility: hasAccessibility
        ? {
            status: "complete",
            durationMilliseconds: 5,
            snapshot: {
              nodeCount: 4,
              truncated: false,
              root: {
                role: "AXWindow",
                title: "Document",
                children: [
                  {
                    role: "AXTextField",
                    title: "Search",
                    value: "[REDACTED]",
                    focused: true,
                  },
                  {
                    role: "AXStaticText",
                    value: options?.visibleText ?? "Visible body",
                  },
                ],
              },
            },
          }
        : {
            status: "failed",
            durationMilliseconds: 1,
          },
    },
  };
}

test("materializes a private JPEG and bounded AX projection from one artifact", async (t) => {
  const dataRoot = await mkdtemp(join(tmpdir(), "openscreen-screen-context-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const capture = artifact({ visibleText: "x".repeat(20_000) });

  const context = await materializeTurnScreenContext(
    dataRoot,
    capture,
    "observation-1",
    undefined,
    { intentRevision: 6, intentContentEpoch: 5 },
  );

  assert.equal(context.ref.captureId, "capture-1");
  assert.equal(context.ref.observationId, "observation-1");
  assert.equal(context.ref.intentRevision, 6);
  assert.equal(context.ref.artifactRevision, 4);
  assert.equal(context.ref.completedRevision, 4);
  assert.equal(context.ref.intentContentEpoch, 5);
  assert.equal(context.ref.artifactContentEpoch, 3);
  assert.equal(context.ref.completedContentEpoch, 3);
  assert.equal(context.ref.image?.mimeType, "image/jpeg");
  assert.equal(context.ref.image?.width, 100);
  assert.equal(context.ref.image?.height, 80);
  assert.equal(await readFile(context.ref.image!.path, "utf8"), "jpeg bytes");
  assert.equal((await stat(context.ref.image!.path)).mode & 0o777, 0o600);
  assert.equal(context.accessibility?.captureId, "capture-1");
  assert.equal(context.accessibility?.focusedElement?.value, "[REDACTED]");
  assert.ok(JSON.stringify(context.accessibility).length <= 10_000);
});

test("reuses the JPEG already persisted with the capture artifact", async (t) => {
  const dataRoot = await mkdtemp(join(tmpdir(), "openscreen-screen-context-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const persistedPath = join(dataRoot, "capture-1.jpg");
  await writeFile(persistedPath, "persisted jpeg");
  const capture = artifact();
  capture.persistence = {
    structuredPath: join(dataRoot, "capture-1.json"),
    screenshot: {
      path: persistedPath,
      mimeType: "image/jpeg",
      width: 100,
      height: 80,
      sha256: "hash",
      bytes: 14,
    },
  };
  delete capture.result.screenshot.dataBase64;

  const context = await materializeTurnScreenContext(
    dataRoot,
    capture,
    "observation-1",
  );

  assert.equal(context.ref.image?.path, persistedPath);
  assert.equal(await readFile(context.ref.image!.path, "utf8"), "persisted jpeg");
});

test("preserves AX-only partial success without inventing an image", async (t) => {
  const dataRoot = await mkdtemp(join(tmpdir(), "openscreen-screen-context-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));

  const context = await materializeTurnScreenContext(
    dataRoot,
    artifact({ screenshot: false }),
    "observation-1",
  );

  assert.equal(context.ref.image, undefined);
  assert.equal(context.accessibility?.visibleText, "Search\n[REDACTED]\nVisible body");
});

test("materializes chat context when Observation persistence is unavailable", async (t) => {
  const dataRoot = await mkdtemp(join(tmpdir(), "openscreen-screen-context-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));

  const context = await materializeTurnScreenContext(
    dataRoot,
    artifact(),
    undefined,
  );

  assert.equal(context.ref.observationId, undefined);
  assert.equal(context.ref.image?.mimeType, "image/jpeg");
  assert.equal(context.accessibility?.captureId, "capture-1");
});

test("keeps the screenshot when AX projection fails", async (t) => {
  const dataRoot = await mkdtemp(join(tmpdir(), "openscreen-screen-context-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const capture = artifact();
  Object.defineProperty(capture.result.accessibility, "snapshot", {
    get() {
      throw new Error("projection failed");
    },
  });

  const diagnostics: unknown[] = [];
  const context = await materializeTurnScreenContext(
    dataRoot,
    capture,
    undefined,
    (value) => diagnostics.push(value),
  );

  assert.equal(context.ref.image?.mimeType, "image/jpeg");
  assert.equal(context.accessibility, undefined);
  assert.deepEqual(diagnostics, [{
    included: false,
    omittedReason: "projection_failed",
    projectedNodeCount: 0,
  }]);
});

test("does not project AX when the accessibility modality failed", () => {
  assert.equal(
    projectModelScreenContext(artifact({ accessibility: false })),
    undefined,
  );
});

test("omits shell-only accessibility from the model while keeping the screenshot", async (t) => {
  const dataRoot = await mkdtemp(join(tmpdir(), "openscreen-screen-context-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const capture = artifact();
  capture.result.accessibility.snapshot!.root = {
    role: "AXWindow",
    title: "Document",
    children: [
      {
        role: "AXMenuBar",
        children: [{ role: "AXMenuItem", title: "File" }],
      },
      {
        role: "AXToolbar",
        children: [{ role: "AXButton", title: "Back" }],
      },
      { role: "AXStatusBar", value: "Line 1, Column 1" },
    ],
  };
  const diagnostics: unknown[] = [];

  const context = await materializeTurnScreenContext(
    dataRoot,
    capture,
    "observation-1",
    (value) => diagnostics.push(value),
  );

  assert.equal(context.ref.image?.mimeType, "image/jpeg");
  assert.equal(context.accessibility, undefined);
  assert.deepEqual(diagnostics, [{
    included: false,
    omittedReason: "no_useful_content",
    projectedNodeCount: 0,
    candidateNodeCount: 0,
    usefulTextCharacters: 0,
    uniqueTextBlocks: 0,
    contentRootFound: false,
    projectionTruncated: false,
  }]);
});

test("omits AX that only repeats the application and window titles", async (t) => {
  const dataRoot = await mkdtemp(join(tmpdir(), "openscreen-screen-context-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const capture = artifact();
  capture.result.accessibility.snapshot!.root = {
    role: "AXWindow",
    children: [
      { role: "AXStaticText", value: "Editor" },
      { role: "AXStaticText", value: "  Document  " },
    ],
  };
  const diagnostics: ModelAccessibilityProjectionDiagnostics[] = [];

  const context = await materializeTurnScreenContext(
    dataRoot,
    capture,
    "observation-1",
    (value) => diagnostics.push(value),
  );

  assert.equal(context.ref.image?.mimeType, "image/jpeg");
  assert.equal(context.accessibility, undefined);
  assert.deepEqual(diagnostics, [{
    included: false,
    omittedReason: "no_useful_content",
    projectedNodeCount: 0,
    candidateNodeCount: 2,
    usefulTextCharacters: 0,
    uniqueTextBlocks: 0,
    contentRootFound: false,
    projectionTruncated: false,
  }]);
});

test("projects useful AX content and excludes shell subtrees and duplicates", () => {
  const capture = artifact();
  capture.result.accessibility.snapshot!.root = {
    role: "AXWindow",
    title: "Document",
    children: [
      {
        role: "AXToolbar",
        children: [
          { role: "AXTextField", title: "Search", value: "Issue details" },
        ],
      },
      {
        role: "AXWebArea",
        children: [
          {
            role: "AXTextArea",
            title: "Prompt",
            value: "Selected text",
            focused: true,
          },
          { role: "AXStaticText", value: "Issue details" },
          { role: "AXStaticText", value: "Issue details" },
          { role: "AXLink", value: "https://example.com/issues/1" },
        ],
      },
      { role: "AXStatusBar", value: "Ready" },
    ],
  };

  const projection = projectModelScreenContext(capture);

  assert.equal(projection?.focusedElement?.role, "AXTextArea");
  assert.equal(projection?.focusedElement?.value, "Selected text");
  assert.equal(projection?.url, "https://example.com/issues/1");
  assert.equal(
    projection?.visibleText,
    "Prompt\nSelected text\nIssue details\nhttps://example.com/issues/1",
  );
  assert.ok(!projection?.visibleText?.includes("Search"));
  assert.ok(!projection?.visibleText?.includes("Ready"));
});

test("projects useful interactive roles and states without exposing the raw tree", () => {
  const capture = artifact();
  capture.result.accessibility.snapshot!.root = {
    role: "AXWindow",
    children: [{
      role: "AXWebArea",
      children: [
        { role: "AXButton", title: "Save", enabled: false },
        { role: "AXCheckBox", title: "Include context", selected: true },
        { role: "AXStaticText", value: "Document body" },
      ],
    }],
  };

  const projection = projectModelScreenContext(capture);

  assert.deepEqual(projection?.elements, [
    { role: "AXButton", name: "Save", enabled: false },
    {
      role: "AXCheckBox",
      name: "Include context",
      selected: true,
    },
  ]);
  assert.equal(projection?.visibleText, "Save\nInclude context\nDocument body");
  assert.equal("children" in (projection ?? {}), false);
});

test("keeps focused address metadata without adding browser toolbar text", () => {
  const capture = artifact();
  capture.result.accessibility.snapshot!.root = {
    role: "AXWindow",
    children: [
      {
        role: "AXToolbar",
        children: [
          { role: "AXButton", title: "Back" },
          {
            role: "AXTextField",
            title: "Address",
            value: "https://example.com/current",
            focused: true,
          },
        ],
      },
      {
        role: "AXWebArea",
        children: [{ role: "AXStaticText", value: "Page body" }],
      },
    ],
  };

  const projection = projectModelScreenContext(capture);

  assert.equal(projection?.focusedElement?.title, "Address");
  assert.equal(projection?.url, "https://example.com/current");
  assert.equal(projection?.visibleText, "Page body");
});

test("prioritizes web content over non-content groups under the model budget", () => {
  const capture = artifact();
  capture.result.accessibility.snapshot!.root = {
    role: "AXWindow",
    children: [
      {
        role: "AXGroup",
        children: [
          { role: "AXStaticText", value: "browser filler " + "x".repeat(12_000) },
        ],
      },
      {
        role: "AXWebArea",
        children: [
          { role: "AXHeading", value: "Important page heading" },
          { role: "AXStaticText", value: "Important page body" },
        ],
      },
    ],
  };

  const projection = projectModelScreenContext(capture);

  assert.ok(projection?.visibleText?.startsWith(
    "Important page heading\nImportant page body",
  ));
  assert.ok(!projection?.visibleText?.includes("browser filler"));
  assert.ok(JSON.stringify(projection).length <= 10_000);
});

test("reports when a web projection exhausts the model AX budget", async (t) => {
  const dataRoot = await mkdtemp(join(tmpdir(), "openscreen-screen-context-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const capture = artifact();
  capture.result.accessibility.snapshot!.root = {
    role: "AXWindow",
    children: [{
      role: "AXWebArea",
      children: [{ role: "AXStaticText", value: "x".repeat(20_000) }],
    }],
  };
  const diagnostics: ModelAccessibilityProjectionDiagnostics[] = [];

  await materializeTurnScreenContext(
    dataRoot,
    capture,
    "observation-1",
    (value) => diagnostics.push(value),
  );

  assert.equal(diagnostics[0]?.contentRootFound, true);
  assert.equal(diagnostics[0]?.candidateNodeCount, 1);
  assert.equal(diagnostics[0]?.projectionTruncated, true);
});

test("one oversized AX text node cannot consume the remaining web-content budget", () => {
  const capture = artifact();
  capture.result.accessibility.snapshot!.root = {
    role: "AXWindow",
    children: [{
      role: "AXWebArea",
      children: [
        { role: "AXStaticText", value: "x".repeat(20_000) },
        { role: "AXHeading", value: "Important later heading" },
      ],
    }],
  };

  const projection = projectModelScreenContext(capture);

  assert.ok(projection?.visibleText?.includes("Important later heading"));
  assert.ok(JSON.stringify(projection).length <= 10_000);
});

test("uses the expanded ten-thousand-character model AX budget", () => {
  const capture = artifact();
  capture.result.accessibility.snapshot!.root = {
    role: "AXWindow",
    children: [{
      role: "AXWebArea",
      children: Array.from({ length: 5 }, (_, index) => ({
        role: "AXStaticText",
        value: `${index}:` + String(index).repeat(1_850),
      })),
    }],
  };

  const projection = projectModelScreenContext(capture);
  const characters = JSON.stringify(projection).length;

  assert.ok(characters > 8_192);
  assert.ok(characters <= 10_000);
});

test("bounds escaped AX metadata without dropping the matching screenshot", async (t) => {
  const dataRoot = await mkdtemp(join(tmpdir(), "openscreen-screen-context-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const capture = artifact({ visibleText: "http://" + "\0".repeat(3_000) });
  capture.result.window.applicationName = "\0".repeat(1_000);
  capture.result.window.title = "\0".repeat(1_000);
  const focused = capture.result.accessibility.snapshot?.root.children?.[0];
  assert.ok(focused);
  focused.role = "\0".repeat(1_000);
  focused.title = "\0".repeat(1_000);
  focused.value = "\0".repeat(1_000);

  const context = await materializeTurnScreenContext(
    dataRoot,
    capture,
    "observation-1",
  );

  assert.equal(context.ref.image?.mimeType, "image/jpeg");
  assert.ok(JSON.stringify(context.accessibility).length <= 10_000);
});
