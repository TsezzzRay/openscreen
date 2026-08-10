import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { withFileMutationQueue } from "../../src/tools/shared/file-mutation-queue.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("serializes mutations for the same real file including symlink aliases", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openscreen-file-queue-"));
  const file = join(directory, "file.txt");
  const alias = join(directory, "alias.txt");
  await writeFile(file, "initial");
  await symlink(file, alias);
  const release = deferred();
  const started = deferred();
  const order: string[] = [];

  const first = withFileMutationQueue(file, async () => {
    order.push("first:start");
    started.resolve();
    await release.promise;
    order.push("first:end");
  });
  const second = withFileMutationQueue(alias, async () => {
    order.push("second:start");
    order.push("second:end");
  });

  await started.promise;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["first:start"]);
  release.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first:start", "first:end", "second:start", "second:end"]);
});

test("allows mutations for different files to overlap", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openscreen-file-queue-"));
  const release = deferred();
  let active = 0;
  let maximumActive = 0;

  const run = (name: string) => withFileMutationQueue(join(directory, name), async () => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    if (active === 2) release.resolve();
    await release.promise;
    active -= 1;
  });

  await Promise.all([run("one.txt"), run("two.txt")]);
  assert.equal(maximumActive, 2);
});

test("serializes a missing target reached through a symlinked parent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openscreen-file-queue-"));
  const realDirectory = join(directory, "real");
  const aliasDirectory = join(directory, "alias");
  await mkdir(realDirectory);
  await symlink(realDirectory, aliasDirectory);
  const release = deferred();
  const started = deferred();
  const secondStarted = deferred();
  const order: string[] = [];

  const first = withFileMutationQueue(join(realDirectory, "new.txt"), async () => {
    order.push("first:start");
    started.resolve();
    await release.promise;
    order.push("first:end");
  });
  const second = withFileMutationQueue(join(aliasDirectory, "new.txt"), async () => {
    order.push("second:start");
    secondStarted.resolve();
    order.push("second:end");
  });

  await started.promise;
  const state = await Promise.race([
    secondStarted.promise.then(() => "overlapped"),
    new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 50)),
  ]);
  assert.equal(state, "blocked");
  assert.deepEqual(order, ["first:start"]);
  release.resolve();
  await Promise.all([first, second]);
});
