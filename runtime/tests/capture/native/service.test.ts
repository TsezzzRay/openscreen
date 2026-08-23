import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  helperArguments,
  parseHelperReport,
  type HelperReport,
} from "../../../src/capture/native/helper.js";
import {
  NativeCaptureService,
  projectReport,
} from "../../../src/capture/native/service.js";

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x01]);

function report(overrides: Partial<HelperReport> = {}): HelperReport {
  return {
    capturedAt: "2026-08-24T00:00:00Z",
    displays: [],
    ...overrides,
  };
}

test("parses a complete helper report", () => {
  const parsed = parseHelperReport(
    JSON.stringify({
      capturedAt: "2026-08-24T00:00:00Z",
      displays: [
        {
          displayId: 1,
          width: 1470,
          height: 956,
          focused: true,
          path: "/tmp/display-1.jpg",
          bytes: 200,
          pixelWidth: 1470,
          pixelHeight: 956,
        },
      ],
      focused: {
        appName: "Ghostty",
        windowTitle: "npm run dev",
        text: "dev server running",
        nodes: 12,
        displayId: 1,
      },
      errors: { focused: "" },
    }),
  );

  assert.equal(parsed.capturedAt, "2026-08-24T00:00:00Z");
  assert.equal(parsed.displays.length, 1);
  assert.equal(parsed.displays[0]?.path, "/tmp/display-1.jpg");
  assert.equal(parsed.focused?.appName, "Ghostty");
  assert.equal(parsed.focused?.text, "dev server running");
  // An empty message is not an error worth reporting.
  assert.equal(parsed.errors, undefined);
});

test("rejects output that is not a usable report", () => {
  assert.throws(() => parseHelperReport("not json"), /not JSON/);
  assert.throws(() => parseHelperReport("[]"), /displays/);
  assert.throws(() => parseHelperReport(JSON.stringify({ displays: [] })), /capturedAt/);
});

test("keeps a display that failed and drops focus without an application", () => {
  const parsed = parseHelperReport(
    JSON.stringify({
      capturedAt: "2026-08-24T00:00:00Z",
      displays: [
        { displayId: 2, width: 100, height: 100, focused: false, error: "denied" },
      ],
      focused: { nodes: 3 },
    }),
  );

  assert.equal(parsed.displays[0]?.error, "denied");
  assert.equal(parsed.displays[0]?.path, undefined);
  assert.equal(parsed.focused, undefined);
});

test("passes every configured bundle exclusion to the helper", () => {
  assert.deepEqual(
    helperArguments({
      helperPath: "/bin/helper",
      outDir: "/tmp/out",
      scale: 1,
      quality: 0.6,
      maxTextCharacters: 8000,
      excludeBundleIds: ["com.openscreen.app", "com.github.Electron"],
      timeoutMilliseconds: 5000,
    }),
    [
      "--out-dir", "/tmp/out",
      "--scale", "1",
      "--quality", "0.6",
      "--max-text", "8000",
      "--exclude-bundle", "com.openscreen.app",
      "--exclude-bundle", "com.github.Electron",
    ],
  );
});

test("attaches the focused window's identity and text to that display alone", () => {
  const frames = projectReport(
    report({
      displays: [
        { displayId: 2, width: 100, height: 100, focused: false, path: "/tmp/2.jpg" },
        { displayId: 1, width: 100, height: 100, focused: true, path: "/tmp/1.jpg" },
      ],
      focused: {
        appName: "Chrome",
        windowTitle: "bilibili",
        text: "video page",
        nodes: 218,
        displayId: 1,
      },
    }),
    "capture-1",
  );

  // Ordered by monitor, and the window's text never travels to a screen it was
  // not read from — that mismatch is the whole reason this path exists.
  assert.deepEqual(frames.map((frame) => frame.monitorKey), ["1", "2"]);
  assert.deepEqual(
    frames.map((frame) => [frame.application, frame.visibleText]),
    [["Chrome", "video page"], [undefined, undefined]],
  );
  assert.equal(frames[0]?.sourceId, "native-capture:capture-1:1");
  assert.equal(frames[0]?.trigger, "prompt");
});

test("drops a display the helper could not photograph", () => {
  const frames = projectReport(
    report({
      displays: [{ displayId: 1, width: 100, height: 100, focused: true, error: "denied" }],
      focused: { appName: "Chrome", nodes: 1, displayId: 1 },
    }),
    "capture-2",
  );

  assert.deepEqual(frames, []);
});

test("reads each frame's bytes and clears the scratch directory", async (t) => {
  const outDir = await mkdtemp(join(tmpdir(), "openscreen-native-test-"));
  t.after(() => rm(outDir, { recursive: true, force: true }));
  const good = join(outDir, "display-1.jpg");
  const truncated = join(outDir, "display-2.jpg");
  await writeFile(good, JPEG);
  await writeFile(truncated, new Uint8Array([0x00, 0x01]));

  const service = new NativeCaptureService({
    helperPath: "/bin/helper",
    makeTempDir: async () => outDir,
    run: async () =>
      report({
        displays: [
          { displayId: 1, width: 10, height: 10, focused: true, path: good },
          { displayId: 2, width: 10, height: 10, focused: false, path: truncated },
        ],
        focused: { appName: "Ghostty", nodes: 2, displayId: 1 },
      }),
  });

  const context = await service.capture("request-1");

  // Anything that is not a readable JPEG is left out rather than sent as one.
  assert.deepEqual(context.frames.map((frame) => frame.monitorKey), ["1"]);
  assert.deepEqual(context.images.map((image) => [...image.data]), [[...JPEG]]);
  assert.equal(context.images[0]?.sourceId, context.frames[0]?.sourceId);
  assert.equal(existsSync(outDir), false);
});

test("aborts before spawning and clears the scratch directory", async (t) => {
  const outDir = await mkdtemp(join(tmpdir(), "openscreen-native-test-"));
  t.after(() => rm(outDir, { recursive: true, force: true }));
  let spawned = false;
  const service = new NativeCaptureService({
    helperPath: "/bin/helper",
    makeTempDir: async () => outDir,
    run: async () => {
      spawned = true;
      return report();
    },
  });

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => service.capture("request-1", controller.signal),
    /aborted/i,
  );
  assert.equal(spawned, false);
});
