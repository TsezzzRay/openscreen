import assert from "node:assert/strict";
import test from "node:test";

import { startObservationInBackground } from "../src/process.js";

test("starts screen observation without blocking agent request handling", async () => {
  let finishStart: (() => void) | undefined;
  const startPending = new Promise<void>((resolve) => {
    finishStart = resolve;
  });
  let started = false;

  startObservationInBackground(
    async () => {
      started = true;
      await startPending;
    },
    () => assert.fail("observation startup should not fail"),
  );

  assert.equal(started, true);
  finishStart?.();
  await startPending;
});
