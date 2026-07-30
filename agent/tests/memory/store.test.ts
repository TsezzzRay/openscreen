import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  appendTimelineEntry,
  readTimelineEntries,
} from "../../src/harness/memory/timeline/store.js";
import { withMemoryLock } from "../../src/harness/memory/store.js";
import type { TimelineEntry } from "../../src/harness/memory/timeline/types.js";

const entry: TimelineEntry = {
  schemaVersion: 1,
  id: "timeline:screen:observation-1",
  occurredAt: "2026-07-27T00:00:00.000Z",
  createdAt: "2026-07-27T00:00:01.000Z",
  source: { type: "screen", id: "observation-1" },
  status: "observed",
  summary: "The user viewed the OpenScreen design.",
  application: "Safari",
  windowTitle: "OpenScreen",
  entities: ["OpenScreen"],
  verbatimEvidence: ["Activity memory design"],
};
const execFileAsync = promisify(execFile);

test("stores timeline entries in daily private JSONL files", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-activity-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  await appendTimelineEntry(root, entry);

  const path = join(root, "timeline", "2026-07-27.jsonl");
  assert.deepEqual(
    JSON.parse((await readFile(path, "utf8")).trim()),
    entry,
  );
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.deepEqual(await readTimelineEntries(root), [entry]);
});

test("truncates an incomplete timeline tail before appending", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-activity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await appendTimelineEntry(root, entry);
  const path = join(root, "timeline", "2026-07-27.jsonl");
  await appendFile(path, '{"id":"interrupted"');

  const second = {
    ...entry,
    id: "timeline:screen:observation-2",
    source: { type: "screen" as const, id: "observation-2" },
  };
  await appendTimelineEntry(root, second);

  assert.deepEqual(await readTimelineEntries(root), [entry, second]);
});

test("recovers a stale activity lock without deleting a new owner", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-activity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lock = join(root, ".activity-memory.lock");
  await mkdir(lock);
  await writeFile(
    join(lock, "owner-stale.json"),
    JSON.stringify({ pid: 999_999_999, token: "stale" }),
  );
  const old = new Date("2020-01-01T00:00:00.000Z");
  await utimes(lock, old, old);
  let ran = false;

  await withMemoryLock(root, async () => {
    ran = true;
  });

  assert.equal(ran, true);
  await assert.rejects(stat(lock), { code: "ENOENT" });
});

test("serializes two waiters recovering the same stale activity lock", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-activity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lock = join(root, ".activity-memory.lock");
  await mkdir(lock);
  await writeFile(
    join(lock, "owner-stale.json"),
    JSON.stringify({ pid: 999_999_999, token: "stale" }),
  );
  const old = new Date("2020-01-01T00:00:00.000Z");
  await utimes(lock, old, old);

  let active = 0;
  let maximumActive = 0;
  let entered = 0;
  const ownerNames: string[] = [];
  let notifyFirst!: () => void;
  let releaseFirst!: () => void;
  const firstEntered = new Promise<void>((resolve) => {
    notifyFirst = resolve;
  });
  const firstRelease = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const operation = async () => {
    active += 1;
    entered += 1;
    maximumActive = Math.max(maximumActive, active);
    ownerNames.push((await readdir(lock)).find((name) => name.startsWith("owner")) ?? "");
    if (entered === 1) {
      notifyFirst();
      await firstRelease;
    }
    active -= 1;
  };

  const first = withMemoryLock(root, operation);
  const second = withMemoryLock(root, operation);
  await firstEntered;
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(entered, 1);
  releaseFirst();
  await Promise.all([first, second]);
  assert.equal(entered, 2);
  assert.equal(maximumActive, 1);
  assert.notEqual(ownerNames[0], ownerNames[1]);
});

test("recovers a stale empty-directory recovery marker", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-activity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lock = join(root, ".activity-memory.lock");
  await mkdir(lock);
  await writeFile(join(lock, "recovery"), "");
  const old = new Date("2020-01-01T00:00:00.000Z");
  await utimes(lock, old, old);
  const storeURL = new URL("../../src/harness/memory/store.js", import.meta.url).href;

  await execFileAsync(process.execPath, [
    "--input-type=module",
    "--eval",
    `import { withMemoryLock } from ${JSON.stringify(storeURL)};
await withMemoryLock(process.argv[1], async () => {});`,
    root,
  ], { timeout: 3000 });

  await assert.rejects(stat(lock), { code: "ENOENT" });
});

test("serializes two waiters recovering a stale empty lock directory", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-activity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lock = join(root, ".activity-memory.lock");
  await mkdir(lock);
  const old = new Date("2020-01-01T00:00:00.000Z");
  await utimes(lock, old, old);
  let active = 0;
  let maximumActive = 0;
  let entered = 0;
  let notifyFirst!: () => void;
  let releaseFirst!: () => void;
  const firstEntered = new Promise<void>((resolve) => {
    notifyFirst = resolve;
  });
  const firstRelease = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const operation = async () => {
    active += 1;
    entered += 1;
    maximumActive = Math.max(maximumActive, active);
    if (entered === 1) {
      notifyFirst();
      await firstRelease;
    }
    active -= 1;
  };

  const first = withMemoryLock(root, operation);
  const second = withMemoryLock(root, operation);
  await firstEntered;
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(entered, 1);
  releaseFirst();
  await Promise.all([first, second]);
  assert.equal(maximumActive, 1);
});
