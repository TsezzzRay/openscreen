import assert from "node:assert/strict";
import test from "node:test";

import { RetryingMemoryLifecycle } from "../../src/memory/lifecycle.js";

test("retries a failed Memory start and stops the recovered service", async () => {
  let starts = 0;
  let stops = 0;
  let scheduled: (() => void) | undefined;
  let scheduledDelay: number | undefined;
  let unrefCalls = 0;
  const timer = { unref: () => { unrefCalls += 1; } };
  const lifecycle = new RetryingMemoryLifecycle({
    service: {
      start: async () => {
        starts += 1;
        if (starts === 1) throw new Error("unavailable");
      },
      stop: async () => { stops += 1; },
    },
    retryMilliseconds: 2_000,
    setRetryTimer: (callback, delay) => {
      scheduled = callback;
      scheduledDelay = delay;
      return timer;
    },
    clearRetryTimer: () => {},
  });

  await lifecycle.start();
  assert.equal(starts, 1);
  assert.equal(scheduledDelay, 2_000);
  assert.equal(unrefCalls, 1);

  scheduled?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(starts, 2);

  await lifecycle.stop();
  assert.equal(stops, 1);
});

test("stop cancels a pending Memory retry", async () => {
  let starts = 0;
  let stops = 0;
  let scheduled: (() => void) | undefined;
  let cleared = false;
  const timer = { unref: () => {} };
  const lifecycle = new RetryingMemoryLifecycle({
    service: {
      start: async () => {
        starts += 1;
        throw new Error("unavailable");
      },
      stop: async () => { stops += 1; },
    },
    retryMilliseconds: 2_000,
    setRetryTimer: (callback) => {
      scheduled = callback;
      return timer;
    },
    clearRetryTimer: (candidate) => {
      assert.equal(candidate, timer);
      cleared = true;
    },
  });

  await lifecycle.start();
  await lifecycle.stop();
  scheduled?.();
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(cleared, true);
  assert.equal(starts, 1);
  assert.equal(stops, 1);
});

test("stop waits for an in-flight Memory retry before closing the service", async () => {
  let starts = 0;
  let stops = 0;
  let scheduled: (() => void) | undefined;
  let finishRetry: (() => void) | undefined;
  const timer = { unref: () => {} };
  const lifecycle = new RetryingMemoryLifecycle({
    service: {
      start: async () => {
        starts += 1;
        if (starts === 1) throw new Error("unavailable");
        await new Promise<void>((resolve) => { finishRetry = resolve; });
      },
      stop: async () => { stops += 1; },
    },
    retryMilliseconds: 2_000,
    setRetryTimer: (callback) => {
      scheduled = callback;
      return timer;
    },
    clearRetryTimer: () => {},
  });

  await lifecycle.start();
  scheduled?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const stopped = lifecycle.stop();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(stops, 0);

  finishRetry?.();
  await stopped;
  assert.equal(stops, 1);
});
