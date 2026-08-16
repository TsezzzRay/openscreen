import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { RecorderOptions } from "@screenpipe/sdk";

import {
  ScreenpipeRuntime,
  type ScreenpipeRecorder,
} from "../../../src/capture/screenpipe/runtime.js";
import type {
  ScreenFrameSource,
} from "../../../src/capture/screenpipe/frame-source.js";
import type {
  ScreenpipeDatabase,
} from "../../../src/capture/screenpipe/database.js";

test("starts one generation before opening its latest-frame database", async (t) => {
  const dataRoot = await mkdtemp(join(tmpdir(), "openscreen-screenpipe-runtime-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));

  const environment: NodeJS.ProcessEnv = {};
  const events: string[] = [];
  const frames: ScreenFrameSource[] = [{
    sourceId: 'screenpipe-frame:["generation-1","12"]',
    generationId: "generation-1",
    frameId: "12",
    monitorKey: "2",
    deviceName: "Studio Display",
    capturedAt: "2026-08-15T01:02:03.000Z",
    trigger: "click",
    imagePath: "/captures/1_m2.jpg",
  }];
  let recorderOptions: RecorderOptions | undefined;
  let databasePath: string | undefined;
  let databaseGenerationId: string | undefined;
  const database: ScreenpipeDatabase = {
    close: () => events.push("database.close"),
    latestFrames: () => frames,
    framesAfter: (cursor) => ({ frames, cursor, hasMore: false }),
  };
  const recorder: ScreenpipeRecorder = {
    start: async () => {
      events.push("recorder.start");
    },
    stop: async () => {
      events.push("recorder.stop");
    },
  };
  const runtime = new ScreenpipeRuntime({
    dataRoot,
    ignoredWindows: ["OpenScreen"],
    ignoredUrls: ["bank.example"],
    environment,
    generationIdFactory: () => "generation-1",
    recorderFactory: (options) => {
      assert.equal(environment.SCREENPIPE_SDK_TELEMETRY, "0");
      recorderOptions = options;
      events.push("recorder.created");
      return recorder;
    },
    databaseFactory: (path, generationId) => {
      events.push("database.open");
      databasePath = path;
      databaseGenerationId = generationId;
      return database;
    },
  });

  await runtime.start();

  const generationRoot = join(
    dataRoot,
    "screenpipe",
    "generations",
    "generation-1",
  );
  assert.deepEqual(runtime.generation(), {
    generationId: "generation-1",
    generationRoot,
  });
  assert.equal((await stat(generationRoot)).mode & 0o777, 0o700);
  assert.deepEqual(events, ["recorder.created", "recorder.start", "database.open"]);
  assert.equal(recorderOptions?.dataDir, generationRoot);
  assert.deepEqual(recorderOptions?.pairedMonitors, undefined);
  assert.equal(databasePath, join(generationRoot, "db.sqlite"));
  assert.equal(databaseGenerationId, "generation-1");
  assert.strictEqual(runtime.latestFrames(), frames);
});

test("does not create a second generation and stops its writer before its reader", async (t) => {
  const dataRoot = await mkdtemp(join(tmpdir(), "openscreen-screenpipe-runtime-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));

  const events: string[] = [];
  let recorderCount = 0;
  let databaseCount = 0;
  const runtime = new ScreenpipeRuntime({
    dataRoot,
    ignoredWindows: [],
    ignoredUrls: [],
    generationIdFactory: () => "generation-1",
    recorderFactory: () => {
      recorderCount += 1;
      return {
        start: async () => {
          events.push("recorder.start");
        },
        stop: async () => {
          events.push("recorder.stop");
        },
      };
    },
    databaseFactory: () => {
      databaseCount += 1;
      return {
        latestFrames: () => [],
        framesAfter: (cursor) => ({ frames: [], cursor, hasMore: false }),
        close: () => {
          events.push("database.close");
        },
      };
    },
  });

  await runtime.start();
  await runtime.start();
  await runtime.stop();
  await runtime.stop();

  assert.equal(recorderCount, 1);
  assert.equal(databaseCount, 1);
  assert.deepEqual(events, [
    "recorder.start",
    "recorder.stop",
    "database.close",
  ]);
  assert.throws(() => runtime.generation(), /has not started/);
  assert.throws(() => runtime.latestFrames(), /has not started/);
});

test("keeps failed-start generation artifacts after stopping the started recorder", async (t) => {
  const dataRoot = await mkdtemp(join(tmpdir(), "openscreen-screenpipe-runtime-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));

  const events: string[] = [];
  const runtime = new ScreenpipeRuntime({
    dataRoot,
    ignoredWindows: [],
    ignoredUrls: [],
    generationIdFactory: () => "failed-generation",
    recorderFactory: () => ({
      start: async () => {
        events.push("recorder.start");
      },
      stop: async () => {
        events.push("recorder.stop");
      },
    }),
    databaseFactory: () => {
      events.push("database.open");
      throw new Error("db unavailable");
    },
  });

  await assert.rejects(runtime.start(), /db unavailable/);

  assert.deepEqual(events, ["recorder.start", "database.open", "recorder.stop"]);
  await stat(join(
    dataRoot,
    "screenpipe",
    "generations",
    "failed-generation",
  ));
  assert.throws(() => runtime.latestFrames(), /has not started/);
});

test("stops the recorder when its start rejects after native startup", async (t) => {
  const dataRoot = await mkdtemp(join(tmpdir(), "openscreen-screenpipe-runtime-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));

  const events: string[] = [];
  const runtime = new ScreenpipeRuntime({
    dataRoot,
    ignoredWindows: [],
    ignoredUrls: [],
    recorderFactory: () => ({
      start: async () => {
        events.push("recorder.start");
        throw new Error("native startup failed");
      },
      stop: async () => {
        events.push("recorder.stop");
      },
    }),
    databaseFactory: () => {
      throw new Error("database must not open");
    },
  });

  await assert.rejects(runtime.start(), /native startup failed/);

  assert.deepEqual(events, ["recorder.start", "recorder.stop"]);
});

test("serializes stop, restart, and snapshot without mixing generation metadata and frames", async (t) => {
  const dataRoot = await mkdtemp(join(tmpdir(), "openscreen-screenpipe-runtime-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));

  const events: string[] = [];
  const ids = ["generation-a", "generation-b"];
  const sourceFrames = new Map<string, ScreenFrameSource[]>([
    ["generation-a", [runtimeFrame("generation-a", "1")]],
    ["generation-b", [runtimeFrame("generation-b", "2")]],
  ]);
  const runtime = new ScreenpipeRuntime({
    dataRoot,
    ignoredWindows: [],
    ignoredUrls: [],
    generationIdFactory: () => ids.shift() ?? "unexpected-generation",
    recorderFactory: (options) => {
      if (options.dataDir === undefined) throw new Error("missing generation dataDir");
      const generationId = options.dataDir.split("/").at(-1)!;
      return {
        start: async () => {
          events.push(`recorder.start:${generationId}`);
        },
        stop: async () => {
          events.push(`recorder.stop:${generationId}`);
        },
      };
    },
    databaseFactory: (_path, generationId) => ({
      close: () => {
        events.push(`database.close:${generationId}`);
      },
      latestFrames: () => {
        events.push(`database.latest:${generationId}`);
        return sourceFrames.get(generationId) ?? [];
      },
      framesAfter: (cursor) => ({ frames: [], cursor, hasMore: false }),
    }),
  });

  await runtime.start();
  const stopping = runtime.stop();
  const restarting = runtime.start();
  const snapshot = runtime.captureSnapshot();
  const [, , captured] = await Promise.all([stopping, restarting, snapshot]);

  assert.equal(captured.generation.generationId, "generation-b");
  assert.match(captured.generation.generationRoot, /generations\/generation-b$/);
  assert.deepEqual(captured.frames.map((item) => item.generationId), ["generation-b"]);
  assert.notStrictEqual(captured.frames[0], sourceFrames.get("generation-b")?.[0]);
  assert.deepEqual(events, [
    "recorder.start:generation-a",
    "recorder.stop:generation-a",
    "database.close:generation-a",
    "recorder.start:generation-b",
    "database.latest:generation-b",
  ]);
});

test("rejects an atomic snapshot while inactive", async (t) => {
  const dataRoot = await mkdtemp(join(tmpdir(), "openscreen-screenpipe-runtime-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const runtime = new ScreenpipeRuntime({
    dataRoot,
    ignoredWindows: [],
    ignoredUrls: [],
    recorderFactory: () => {
      throw new Error("must not create a recorder");
    },
  });

  await assert.rejects(runtime.captureSnapshot(), /has not started/);
});

test("serializes an incremental read after stop and restart without mixing generations", async (t) => {
  const dataRoot = await mkdtemp(join(tmpdir(), "openscreen-screenpipe-runtime-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));

  const events: string[] = [];
  const ids = ["generation-a", "generation-b"];
  const runtime = new ScreenpipeRuntime({
    dataRoot,
    ignoredWindows: [],
    ignoredUrls: [],
    generationIdFactory: () => ids.shift() ?? "unexpected-generation",
    recorderFactory: (options) => {
      const generationId = options.dataDir?.split("/").at(-1);
      if (generationId === undefined) throw new Error("missing generation dataDir");
      return {
        start: async () => {
          events.push(`recorder.start:${generationId}`);
        },
        stop: async () => {
          events.push(`recorder.stop:${generationId}`);
        },
      };
    },
    databaseFactory: (_path, generationId) => ({
      close: () => {
        events.push(`database.close:${generationId}`);
      },
      latestFrames: () => [],
      framesAfter: (cursor, limit) => {
        events.push(`database.framesAfter:${generationId}:${cursor}:${limit}`);
        return {
          frames: [runtimeFrame(generationId, generationId === "generation-a" ? "1" : "2")],
          cursor: cursor + 1,
          hasMore: false,
        };
      },
    }),
  });

  await runtime.start();
  const stopping = runtime.stop();
  const restarting = runtime.start();
  const read = runtime.readFramesAfter(7, 3);
  const [, , result] = await Promise.all([stopping, restarting, read]);

  assert.deepEqual(result, {
    generation: {
      generationId: "generation-b",
      generationRoot: join(dataRoot, "screenpipe", "generations", "generation-b"),
    },
    frames: [runtimeFrame("generation-b", "2")],
    cursor: 8,
    hasMore: false,
  });
  assert.deepEqual(events, [
    "recorder.start:generation-a",
    "recorder.stop:generation-a",
    "database.close:generation-a",
    "recorder.start:generation-b",
    "database.framesAfter:generation-b:7:3",
  ]);
});

test("keeps retired generations readable until Chronicle drains them", async (t) => {
  const dataRoot = await mkdtemp(join(tmpdir(), "openscreen-screenpipe-runtime-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const ids = ["generation-a", "generation-b"];
  const events: string[] = [];
  const runtime = new ScreenpipeRuntime({
    dataRoot,
    ignoredWindows: [],
    ignoredUrls: [],
    generationIdFactory: () => ids.shift() ?? "unexpected",
    recorderFactory: () => ({ start: async () => {}, stop: async () => {} }),
    databaseFactory: (_path, generationId) => ({
      close: () => events.push(`close:${generationId}`),
      latestFrames: () => [],
      framesAfter: (cursor) => ({
        frames: cursor === 0 ? [runtimeFrame(generationId, "1")] : [],
        cursor: cursor === 0 ? 1 : cursor,
        hasMore: false,
      }),
    }),
  });

  await runtime.start();
  await runtime.rotate();

  assert.deepEqual(await runtime.listGenerations(), [
    { generationId: "generation-a", active: false },
    { generationId: "generation-b", active: true },
  ]);
  const retired = await runtime.readGenerationFramesAfter(
    "generation-a",
    0,
    10,
  );
  assert.equal(retired.generation.generationId, "generation-a");
  assert.deepEqual(retired.frames, [runtimeFrame("generation-a", "1")]);
  assert.equal(events.filter((event) => event === "close:generation-a").length, 2);
  await assert.rejects(
    runtime.readGenerationFramesAfter("missing", 0, 10),
    /not available/,
  );
});

test("rotates at the UTC boundary before snapshot reads", async (t) => {
  const dataRoot = await mkdtemp(join(tmpdir(), "openscreen-screenpipe-runtime-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  let now = Date.parse("2026-08-15T23:59:59.000Z");
  const ids = ["generation-a", "generation-b"];
  const events: string[] = [];
  const runtime = new ScreenpipeRuntime({
    dataRoot,
    ignoredWindows: [],
    ignoredUrls: [],
    now: () => new Date(now),
    generationIdFactory: () => ids.shift() ?? "unexpected",
    recorderFactory: () => ({
      start: async () => {},
      stop: async () => {},
    }),
    databaseFactory: (_path, generationId) => ({
      close: () => events.push(`close:${generationId}`),
      latestFrames: () => {
        events.push(`latest:${generationId}`);
        return [runtimeFrame(generationId, generationId === "generation-a" ? "1" : "2")];
      },
      framesAfter: (cursor) => ({ frames: [], cursor, hasMore: false }),
    }),
  });

  await runtime.start();
  const before = await runtime.captureSnapshot();
  now = Date.parse("2026-08-16T00:00:00.000Z");
  const after = await runtime.captureSnapshot();

  assert.equal(before.generation.generationId, "generation-a");
  assert.equal(after.generation.generationId, "generation-b");
  assert.deepEqual(events, [
    "latest:generation-a",
    "close:generation-a",
    "latest:generation-b",
  ]);
});

test("retries a failed rotation without mixing generations", async (t) => {
  const dataRoot = await mkdtemp(join(tmpdir(), "openscreen-screenpipe-runtime-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  let now = Date.parse("2026-08-15T23:59:59.000Z");
  const ids = ["generation-a", "generation-b"];
  let stopCalls = 0;
  const runtime = new ScreenpipeRuntime({
    dataRoot,
    ignoredWindows: [],
    ignoredUrls: [],
    now: () => new Date(now),
    generationIdFactory: () => ids.shift() ?? "unexpected",
    recorderFactory: () => ({
      start: async () => {},
      stop: async () => {
        stopCalls += 1;
        if (stopCalls === 1) throw new Error("rotation stop failed");
      },
    }),
    databaseFactory: (_path, generationId) => ({
      close: () => {},
      latestFrames: () => [runtimeFrame(generationId, generationId === "generation-a" ? "1" : "2")],
      framesAfter: (cursor) => ({ frames: [], cursor, hasMore: false }),
    }),
  });

  await runtime.start();
  now = Date.parse("2026-08-16T00:00:00.000Z");
  await assert.rejects(runtime.captureSnapshot(), /rotation stop failed/);
  await assert.rejects(runtime.captureSnapshot(), /has not started|rotation stop failed/);
  await runtime.start();
  const recovered = await runtime.captureSnapshot();
  assert.equal(recovered.generation.generationId, "generation-b");
  assert.deepEqual(recovered.frames.map((frame) => frame.generationId), ["generation-b"]);
});

test("uses an unref rotation timer and clears it on stop", async (t) => {
  const dataRoot = await mkdtemp(join(tmpdir(), "openscreen-screenpipe-runtime-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  let unrefCalls = 0;
  let clearCalls = 0;
  const runtime = new ScreenpipeRuntime({
    dataRoot,
    ignoredWindows: [],
    ignoredUrls: [],
    timerFactory: () => ({
      unref: () => {
        unrefCalls += 1;
      },
    }),
    timerClear: () => {
      clearCalls += 1;
    },
    recorderFactory: () => ({ start: async () => {}, stop: async () => {} }),
    databaseFactory: () => ({
      close: () => {},
      latestFrames: () => [],
      framesAfter: (cursor) => ({ frames: [], cursor, hasMore: false }),
    }),
  });

  await runtime.start();
  await runtime.stop();
  assert.equal(unrefCalls, 1);
  assert.equal(clearCalls, 1);
});

test("clears a failed generation when rotation timer setup throws", async (t) => {
  const dataRoot = await mkdtemp(join(tmpdir(), "openscreen-screenpipe-runtime-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const ids = ["generation-a", "generation-b"];
  const events: string[] = [];
  let timerCalls = 0;
  const runtime = new ScreenpipeRuntime({
    dataRoot,
    ignoredWindows: [],
    ignoredUrls: [],
    generationIdFactory: () => ids.shift() ?? "unexpected",
    timerFactory: () => {
      timerCalls += 1;
      if (timerCalls === 1) throw new Error("timer unavailable");
      return {};
    },
    recorderFactory: (options) => {
      const generationId = options.dataDir?.split("/").at(-1);
      if (generationId === undefined) throw new Error("missing generation dataDir");
      return {
        start: async () => {
          events.push(`start:${generationId}`);
        },
        stop: async () => {
          events.push(`stop:${generationId}`);
        },
      };
    },
    databaseFactory: (_path, generationId) => ({
      close: () => {
        events.push(`close:${generationId}`);
      },
      latestFrames: () => [],
      framesAfter: (cursor) => ({ frames: [], cursor, hasMore: false }),
    }),
  });

  await assert.rejects(runtime.start(), /timer unavailable/);
  assert.throws(() => runtime.generation(), /has not started/);
  assert.throws(() => runtime.latestFrames(), /has not started/);

  await runtime.start();
  assert.equal(runtime.generation().generationId, "generation-b");
  assert.deepEqual(events, [
    "start:generation-a",
    "stop:generation-a",
    "close:generation-a",
    "start:generation-b",
  ]);
});

test("emits content-free generation rotation diagnostics", async (t) => {
  const dataRoot = await mkdtemp(join(tmpdir(), "openscreen-screenpipe-runtime-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const diagnostics: Array<{ phase: string; message: string }> = [];
  const ids = ["generation-a", "generation-b"];
  const runtime = new ScreenpipeRuntime({
    dataRoot,
    ignoredWindows: [],
    ignoredUrls: [],
    generationIdFactory: () => ids.shift() ?? "unexpected",
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    recorderFactory: (options) => ({
      start: async () => {
        if (options.dataDir?.endsWith("generation-b")) {
          throw new Error("private path: /Users/person/secret.jpg");
        }
      },
      stop: async () => {},
    }),
    databaseFactory: () => ({
      close: () => {},
      latestFrames: () => [],
      framesAfter: (cursor) => ({ frames: [], cursor, hasMore: false }),
    }),
  });

  await runtime.start();
  await assert.rejects(runtime.rotate(), /private path/);
  assert.deepEqual(diagnostics, [{
    phase: "generation-rotation",
    message: "Generation rotation failed",
  }]);
});

test("rejects an incremental read while inactive", async (t) => {
  const dataRoot = await mkdtemp(join(tmpdir(), "openscreen-screenpipe-runtime-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const runtime = new ScreenpipeRuntime({
    dataRoot,
    ignoredWindows: [],
    ignoredUrls: [],
    recorderFactory: () => {
      throw new Error("must not create a recorder");
    },
  });

  await assert.rejects(runtime.readFramesAfter(0, 1), /has not started/);
});

function runtimeFrame(generationId: string, frameId: string): ScreenFrameSource {
  return {
    sourceId: `screenpipe-frame:["${generationId}","${frameId}"]`,
    generationId,
    frameId,
    monitorKey: frameId,
    deviceName: `Display ${frameId}`,
    capturedAt: "2026-08-15T01:02:03.000Z",
    trigger: "click",
    imagePath: `/captures/${generationId}-${frameId}.jpg`,
  };
}
