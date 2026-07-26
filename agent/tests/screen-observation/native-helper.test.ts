import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { NativeHelperClient } from "../../src/screen-observation/native-helper.js";
import type { NativeActivitySignal } from "../../src/screen-observation/types.js";

const testSignal: NativeActivitySignal = {
  kind: "focusedWindowChanged",
  occurredAt: "2026-07-27T00:00:00.000Z",
  window: {
    processIdentifier: 100,
    bundleIdentifier: "com.example.Editor",
    applicationName: "Editor",
    windowIdentifier: 7,
    title: "Document",
  },
};

const helperSource = `
import { createInterface } from "node:readline";
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
      signal: ${JSON.stringify(testSignal)},
    }) + "\\n");
  }
  if (command.type === "capture") {
    process.stdout.write(JSON.stringify({
      protocolVersion: 1,
      requestId: command.requestId,
      type: "captureResult",
      result: {
        capturedAt: "2026-07-27T00:00:01.000Z",
        window: command.signal.window,
        screenshot: {
          status: "complete",
          durationMilliseconds: 10,
          mimeType: "image/jpeg",
          dataBase64: "aW1hZ2U=",
          width: 100,
          height: 80,
        },
        accessibility: {
          status: "complete",
          durationMilliseconds: 5,
          snapshot: {
            nodeCount: 1,
            truncated: false,
            root: { role: "AXWindow", title: "Document" },
          },
        },
        visualSignature: [0, 128, 255],
      },
    }) + "\\n");
  }
  if (command.type === "shutdown") process.exit(0);
}
`;

test("starts, configures, captures, forwards signals, and stops a helper process", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openscreen-helper-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const helperPath = join(directory, "helper.mjs");
  await writeFile(helperPath, helperSource);
  const signals: NativeActivitySignal[] = [];
  const states: string[] = [];
  const client = new NativeHelperClient({
    command: process.execPath,
    arguments: [helperPath],
    excludedProcessIdentifiers: [10, 20],
    excludedBundleIdentifiers: ["com.openscreen.app"],
    onSignal: (signal) => signals.push(signal),
    onLifecycle: (state) => states.push(state),
  });
  t.after(() => client.stop());

  await client.start();
  const result = await client.capture(testSignal);

  assert.equal(result.window.windowIdentifier, 7);
  assert.equal(result.screenshot.status, "complete");
  assert.equal(result.accessibility.snapshot?.root.title, "Document");
  assert.deepEqual(signals, [testSignal]);
  await client.stop();
  assert.equal(client.running, false);
  assert.equal(states.filter((state) => state === "stopped").length, 1);
});

test("restarts a crashed helper only up to the configured limit", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openscreen-helper-restart-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const countPath = join(directory, "count.txt");
  const helperPath = join(directory, "crashing-helper.mjs");
  await writeFile(helperPath, `
    import { readFileSync, writeFileSync } from "node:fs";
    const path = process.env.HELPER_COUNT_PATH;
    let count = 0;
    try { count = Number(readFileSync(path, "utf8")); } catch {}
    writeFileSync(path, String(count + 1));
    process.stdout.write(JSON.stringify({
      protocolVersion: 1,
      type: "ready",
      processIdentifier: process.pid,
    }) + "\\n");
    process.stdin.once("data", (data) => {
      const command = JSON.parse(String(data).trim());
      process.stdout.write(JSON.stringify({
        protocolVersion: 1,
        requestId: command.requestId,
        type: "configured",
      }) + "\\n");
      setTimeout(() => process.exit(1), 5);
    });
  `);
  const states: string[] = [];
  const client = new NativeHelperClient({
    command: process.execPath,
    arguments: [helperPath],
    environment: { ...process.env, HELPER_COUNT_PATH: countPath },
    excludedProcessIdentifiers: [],
    excludedBundleIdentifiers: [],
    maxRestarts: 2,
    restartDelayMilliseconds: 1,
    onSignal: () => {},
    onLifecycle: (state) => states.push(state),
  });
  t.after(() => client.stop());

  await client.start();
  await waitFor(async () => Number(await readFile(countPath, "utf8")) === 3);
  await waitFor(() => states.includes("degraded"));

  assert.equal(await readFile(countPath, "utf8"), "3");
  assert.equal(states.filter((state) => state === "restarting").length, 2);
  assert.equal(client.running, false);
});

async function waitFor(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 2_000;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for helper state");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
