import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DEFAULT_GENERATION_POLICY,
  ScreenpipeGenerationStore,
} from "../../../src/capture/screenpipe/generation-store.js";

test("creates private generation directories under an absolute root", async (t) => {
  const dataRoot = await mkdtemp(join(tmpdir(), "openscreen-generation-store-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const store = new ScreenpipeGenerationStore({ dataRoot });

  const generation = await store.createGeneration("generation-1");

  assert.equal((await stat(generation.generationsRoot)).mode & 0o777, 0o700);
  assert.equal((await stat(generation.generationRoot)).mode & 0o777, 0o700);
  assert.equal(generation.generationId, "generation-1");
  await assert.rejects(
    store.createGeneration("../outside"),
    /single path segment/,
  );
});

test("retention removes old and oldest inactive generations but protects active", async (t) => {
  const dataRoot = await mkdtemp(join(tmpdir(), "openscreen-generation-store-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const now = Date.now();
  const store = new ScreenpipeGenerationStore({
    dataRoot,
    now: () => new Date(now),
    policy: { ...DEFAULT_GENERATION_POLICY, maxAgeMilliseconds: 7 * 24 * 60 * 60 * 1000, maxBytes: 5 },
  });
  const old = await store.createGeneration("old");
  const middle = await store.createGeneration("middle");
  const active = await store.createGeneration("active");
  await writeFile(join(old.generationRoot, "bytes"), "1234");
  await writeFile(join(middle.generationRoot, "bytes"), "1234");
  await writeFile(join(active.generationRoot, "bytes"), "1234");
  const oldTime = new Date(now - 7 * 24 * 60 * 60 * 1000);
  await utimes(old.generationRoot, oldTime, oldTime);
  await utimes(middle.generationRoot, new Date(now - 2 * 24 * 60 * 60 * 1000), new Date(now - 2 * 24 * 60 * 60 * 1000));

  await store.retain(active.generationRoot);

  await assert.rejects(stat(old.generationRoot));
  await assert.rejects(stat(middle.generationRoot));
  assert.equal((await stat(active.generationRoot)).isDirectory(), true);
});

test("retention protects inactive generations until Chronicle acknowledges them", async (t) => {
  const dataRoot = await mkdtemp(join(tmpdir(), "openscreen-generation-store-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const now = Date.now();
  const completed = new Set(["completed"]);
  const store = new ScreenpipeGenerationStore({
    dataRoot,
    now: () => new Date(now),
    policy: { maxAgeMilliseconds: 1, maxBytes: 1 },
    canDeleteGeneration: async (generationId) => completed.has(generationId),
  });
  const pending = await store.createGeneration("pending");
  const removable = await store.createGeneration("completed");
  const active = await store.createGeneration("active");
  await writeFile(join(pending.generationRoot, "bytes"), "1234");
  await writeFile(join(removable.generationRoot, "bytes"), "1234");
  await writeFile(join(active.generationRoot, "bytes"), "1234");
  const old = new Date(now - 10);
  await utimes(pending.generationRoot, old, old);
  await utimes(removable.generationRoot, old, old);

  await store.retain(active.generationRoot);

  assert.equal((await stat(pending.generationRoot)).isDirectory(), true);
  await assert.rejects(stat(removable.generationRoot));
  assert.equal((await stat(active.generationRoot)).isDirectory(), true);
});

test("never follows or deletes a generation symlink", async (t) => {
  const dataRoot = await mkdtemp(join(tmpdir(), "openscreen-generation-store-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const outside = await mkdtemp(join(tmpdir(), "openscreen-generation-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const store = new ScreenpipeGenerationStore({
    dataRoot,
    policy: { ...DEFAULT_GENERATION_POLICY, maxBytes: 1 },
  });
  const active = await store.createGeneration("active");
  const link = join(active.generationsRoot, "external");
  await writeFile(join(outside, "keep"), "outside");
  await symlink(outside, link);

  await store.retain(active.generationRoot);

  assert.equal((await lstat(link)).isSymbolicLink(), true);
  assert.equal(await stat(join(outside, "keep")).then(() => true), true);
});

test("reports cleanup failures without deleting the active generation", async (t) => {
  const dataRoot = await mkdtemp(join(tmpdir(), "openscreen-generation-store-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const diagnostics: Array<{ phase: string; message: string }> = [];
  const store = new ScreenpipeGenerationStore({
    dataRoot,
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });
  const active = await store.createGeneration("active");
  await chmod(active.generationsRoot, 0o500);

  await store.retain(active.generationRoot);

  assert.equal((await stat(active.generationRoot)).isDirectory(), true);
  assert.ok(diagnostics.every(({ message }) => !message.includes(dataRoot)));
});
