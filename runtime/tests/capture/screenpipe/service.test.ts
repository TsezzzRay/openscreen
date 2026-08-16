import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ScreenpipeCaptureService } from "../../../src/capture/screenpipe/service.js";
import type { ScreenFrameSource } from "../../../src/capture/screenpipe/frame-source.js";
import type { ScreenpipeCaptureSnapshot } from "../../../src/capture/screenpipe/runtime.js";

type AtomicRuntime = {
  start(): Promise<void>;
  stop(): Promise<void>;
  captureSnapshot(): Promise<ScreenpipeCaptureSnapshot>;
};

function frame(
  monitorKey: string,
  imagePath: string,
  generationId = "generation-1",
): ScreenFrameSource {
  return {
    sourceId: `screenpipe-frame:["${generationId}","${monitorKey}"]`,
    generationId,
    frameId: monitorKey,
    monitorKey,
    deviceName: `Display ${monitorKey}`,
    capturedAt: "2026-08-15T01:02:03.000Z",
    trigger: "click",
    imagePath,
  };
}

test("reads one atomic snapshot and returns ordered canonical JPEG bytes", async (t) => {
  const root = await mkdirGenerationRoot();
  t.after(() => rm(root.dataRoot, { recursive: true, force: true }));
  const data = join(root.generationRoot, "data");
  await mkdir(data);
  const one = join(data, "one.jpg");
  const two = join(data, "two.jpeg");
  const oneBytes = Buffer.from([0xff, 0xd8, 0x01, 0x02]);
  const twoBytes = Buffer.from([0xff, 0xd8, 0x03, 0x04]);
  await writeFile(one, oneBytes);
  await writeFile(two, twoBytes);

  let snapshotCalls = 0;
  const service = new ScreenpipeCaptureService({
    runtime: {
      start: async () => {},
      stop: async () => {},
      captureSnapshot: async () => {
        snapshotCalls += 1;
        return snapshot(root.generationRoot, [frame("2", "data/two.jpeg"), frame("1", one)]);
      },
    },
  });

  const context = await service.capture("request-1");

  assert.equal(snapshotCalls, 1);
  assert.deepEqual(context.frames.map((item) => item.monitorKey), ["2", "1"]);
  assert.deepEqual(context.frames.map((item) => item.imagePath), [
    await realpath(two),
    await realpath(one),
  ]);
  assert.deepEqual((context.images ?? []).map((image) => image.sourceId), [
    'screenpipe-frame:["generation-1","2"]',
    'screenpipe-frame:["generation-1","1"]',
  ]);
  assert.deepEqual((context.images ?? []).map((image) => Buffer.from(image.data)), [
    twoBytes,
    oneBytes,
  ]);
});

test("rejects a symlinked generation root before reading frame files", async (t) => {
  const root = await mkdirGenerationRoot();
  t.after(() => rm(root.dataRoot, { recursive: true, force: true }));
  const link = join(root.dataRoot, "generation-link");
  await symlink(root.generationRoot, link);
  const service = new ScreenpipeCaptureService({
    runtime: runtime(link, []),
  });

  await assert.rejects(
    service.capture("symlink-root"),
    /generation root security validation/,
  );
});

test("rejects a generation root with broad permissions", async (t) => {
  const root = await mkdirGenerationRoot();
  t.after(() => rm(root.dataRoot, { recursive: true, force: true }));
  await chmod(root.generationRoot, 0o755);
  const service = new ScreenpipeCaptureService({
    runtime: runtime(root.generationRoot, []),
  });

  await assert.rejects(
    service.capture("wide-root"),
    /generation root security validation/,
  );
});

test("rejects a generation root that is not a directory", async (t) => {
  const dataRoot = await mkdtemp(join(tmpdir(), "openscreen-screenpipe-service-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const generationRoot = join(dataRoot, "generation-file");
  await writeFile(generationRoot, "not a directory");
  const service = new ScreenpipeCaptureService({
    runtime: runtime(generationRoot, []),
  });

  await assert.rejects(
    service.capture("file-root"),
    /generation root security validation/,
  );
});

test("omits missing, invalid, and escaped image files without dropping usable frames", async (t) => {
  const root = await mkdirGenerationRoot();
  t.after(() => rm(root.dataRoot, { recursive: true, force: true }));
  const data = join(root.generationRoot, "data");
  await mkdir(data);
  const valid = join(data, "valid.jpg");
  const invalidHeader = join(data, "bad-header.jpg");
  const directory = join(data, "directory.jpeg");
  const outside = join(root.dataRoot, "outside.jpg");
  await writeFile(valid, Buffer.from([0xff, 0xd8, 0x00]));
  await writeFile(invalidHeader, Buffer.from([0x89, 0x50, 0x4e]));
  await mkdir(directory);
  await writeFile(outside, Buffer.from([0xff, 0xd8, 0x00]));
  const escapedLink = join(data, "escaped.jpeg");
  try {
    await symlink(outside, escapedLink);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      t.skip("symlink creation is unavailable on this platform");
      return;
    }
    throw error;
  }

  const service = new ScreenpipeCaptureService({
    runtime: runtime(root.generationRoot, [
      frame("1", "data/valid.jpg"),
      frame("2", "data/missing.jpg"),
      frame("3", "data/bad-header.jpg"),
      frame("4", "data/directory.jpeg"),
      frame("5", "../outside.jpg"),
      frame("6", "data/escaped.jpeg"),
    ]),
  });

  const context = await service.capture("request-1");

  assert.deepEqual(context.frames.map((item) => item.monitorKey), ["1"]);
  assert.equal(context.frames[0]?.imagePath, await realpath(valid));
  assert.deepEqual((context.images ?? []).map((image) => Buffer.from(image.data)), [
    Buffer.from([0xff, 0xd8, 0x00]),
  ]);
});

test("omits a frame whose generation differs from the atomic snapshot", async (t) => {
  const root = await mkdirGenerationRoot();
  t.after(() => rm(root.dataRoot, { recursive: true, force: true }));
  await mkdir(join(root.generationRoot, "data"));
  const matching = join(root.generationRoot, "data", "matching.jpg");
  const mismatch = join(root.generationRoot, "data", "mismatch.jpg");
  await writeFile(matching, Buffer.from([0xff, 0xd8, 0x01]));
  await writeFile(mismatch, Buffer.from([0xff, 0xd8, 0x02]));
  const service = new ScreenpipeCaptureService({
    runtime: runtime(root.generationRoot, [
      frame("1", mismatch, "old-generation"),
      frame("2", matching),
    ]),
  });

  const context = await service.capture("request-1");

  assert.deepEqual(context.frames.map((item) => item.sourceId), [
    'screenpipe-frame:["generation-1","2"]',
  ]);
  assert.deepEqual((context.images ?? []).map((image) => image.sourceId), [
    'screenpipe-frame:["generation-1","2"]',
  ]);
});

test("delegates lifecycle methods and propagates an atomic snapshot failure", async (t) => {
  const root = await mkdirGenerationRoot();
  t.after(() => rm(root.dataRoot, { recursive: true, force: true }));
  let starts = 0;
  let stops = 0;
  const service = new ScreenpipeCaptureService({
    runtime: {
      start: async () => {
        starts += 1;
      },
      stop: async () => {
        stops += 1;
      },
      captureSnapshot: async () => {
        throw new Error("database unavailable");
      },
    },
  });

  await service.start();
  await service.stop();
  await assert.rejects(service.capture("request-1"), /database unavailable/);
  assert.equal(starts, 1);
  assert.equal(stops, 1);
});

test("returns aligned empty frames and image bytes when no JPEG is usable", async (t) => {
  const root = await mkdirGenerationRoot();
  t.after(() => rm(root.dataRoot, { recursive: true, force: true }));
  const service = new ScreenpipeCaptureService({
    runtime: runtime(root.generationRoot, [frame("1", "missing.jpg")]),
  });

  assert.deepEqual(await service.capture("request-1"), {
    type: "frames",
    frames: [],
    images: [],
  });
});

test("throws AbortError while awaiting an empty atomic snapshot", async (t) => {
  const root = await mkdirGenerationRoot();
  t.after(() => rm(root.dataRoot, { recursive: true, force: true }));
  const controller = new AbortController();
  let resolveSnapshot!: (value: ScreenpipeCaptureSnapshot) => void;
  const pendingSnapshot = new Promise<ScreenpipeCaptureSnapshot>((resolve) => {
    resolveSnapshot = resolve;
  });
  const service = new ScreenpipeCaptureService({
    runtime: {
      start: async () => {},
      stop: async () => {},
      captureSnapshot: async () => pendingSnapshot,
    },
  });

  const capture = service.capture("request-1", controller.signal);
  controller.abort();
  resolveSnapshot(snapshot(root.generationRoot, []));

  await assert.rejects(capture, isAbortError);
});

test("throws AbortError while awaiting the atomic generation root", async (t) => {
  const root = await mkdirGenerationRoot();
  t.after(() => rm(root.dataRoot, { recursive: true, force: true }));
  const controller = new AbortController();
  const service = new ScreenpipeCaptureService({
    runtime: {
      start: async () => {},
      stop: async () => {},
      captureSnapshot: async () => ({
        generation: {
          generationId: "generation-1",
          get generationRoot() {
            queueMicrotask(() => controller.abort());
            return root.generationRoot;
          },
        },
        frames: [],
      }),
    },
  });

  await assert.rejects(service.capture("request-1", controller.signal), isAbortError);
});

test("throws AbortError when the signal aborts while checking a frame", async (t) => {
  const root = await mkdirGenerationRoot();
  t.after(() => rm(root.dataRoot, { recursive: true, force: true }));
  await mkdir(join(root.generationRoot, "data"));
  const image = join(root.generationRoot, "data", "image.jpg");
  await writeFile(image, Buffer.from([0xff, 0xd8, 0x00]));
  const controller = new AbortController();
  const source = frame("1", image);
  Object.defineProperty(source, "imagePath", {
    get() {
      queueMicrotask(() => controller.abort());
      return image;
    },
  });
  const service = new ScreenpipeCaptureService({
    runtime: runtime(root.generationRoot, [source]),
  });

  await assert.rejects(service.capture("request-1", controller.signal), isAbortError);
});

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function snapshot(
  generationRoot: string,
  frames: ScreenFrameSource[],
): ScreenpipeCaptureSnapshot {
  return {
    generation: { generationId: "generation-1", generationRoot },
    frames,
  };
}

function runtime(generationRoot: string, frames: ScreenFrameSource[]): AtomicRuntime {
  return {
    start: async () => {},
    stop: async () => {},
    captureSnapshot: async () => snapshot(generationRoot, frames),
  };
}

async function mkdirGenerationRoot(): Promise<{
  dataRoot: string;
  generationRoot: string;
}> {
  const dataRoot = await mkdtemp(join(tmpdir(), "openscreen-screenpipe-service-"));
  const canonicalDataRoot = await realpath(dataRoot);
  const generationRoot = join(
    canonicalDataRoot,
    "screenpipe",
    "generations",
    "generation-1",
  );
  await mkdir(generationRoot, { recursive: true, mode: 0o700 });
  await chmod(generationRoot, 0o700);
  return { dataRoot, generationRoot };
}
