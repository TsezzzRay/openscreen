import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ScreenObservationRuntime } from "../../src/screen-observation/runtime.js";

test("turns helper signals into an in-memory latest observation", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openscreen-observation-runtime-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const helperPath = join(directory, "helper.mjs");
  await writeFile(helperPath, `
    import { createInterface } from "node:readline";
    const window = {
      processIdentifier: 100,
      bundleIdentifier: "com.example.Editor",
      applicationName: "Editor",
      windowIdentifier: 7,
      title: "Document",
    };
    process.stdout.write(JSON.stringify({
      protocolVersion: 1,
      type: "ready",
      processIdentifier: process.pid,
    }) + "\\n");
    const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
    for await (const line of lines) {
      const command = JSON.parse(line);
      if (command.type === "configure") {
        process.stdout.write(JSON.stringify({
          protocolVersion: 1,
          requestId: command.requestId,
          type: "configured",
        }) + "\\n");
        process.stdout.write(JSON.stringify({
          protocolVersion: 1,
          type: "signal",
          signal: {
            kind: "focusedWindowChanged",
            occurredAt: "2026-07-27T00:00:00.000Z",
            window,
          },
        }) + "\\n");
      }
      if (command.type === "capture") {
        process.stdout.write(JSON.stringify({
          protocolVersion: 1,
          requestId: command.requestId,
          type: "captureResult",
          result: {
            capturedAt: "2026-07-27T00:00:01.000Z",
            window,
            screenshot: {
              status: "permissionDenied",
              durationMilliseconds: 1,
            },
            accessibility: {
              status: "complete",
              durationMilliseconds: 1,
              snapshot: {
                nodeCount: 1,
                truncated: false,
                root: { role: "AXWindow", title: "Document" },
              },
            },
          },
        }) + "\\n");
      }
      if (command.type === "shutdown") process.exit(0);
    }
  `);

  const runtime = new ScreenObservationRuntime({
    helperCommand: process.execPath,
    helperArguments: [helperPath],
    tickIntervalMilliseconds: 5,
  });
  t.after(() => runtime.stop());

  await runtime.start();
  await waitFor(() => runtime.latestObservation !== undefined);

  assert.equal(runtime.latestObservation?.window.windowIdentifier, 7);
  assert.equal(runtime.latestObservation?.visibleText, "Document");
  assert.equal(runtime.latestObservation?.screenshot.status, "permissionDenied");
  await runtime.stop();
});

async function waitFor(check: () => boolean) {
  const deadline = Date.now() + 2_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for observation");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
