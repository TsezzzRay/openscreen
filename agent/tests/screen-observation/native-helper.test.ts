import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { NativeHelperClient } from "../../src/screen-observation/native-helper.js";
import type {
  NativeActivitySignal,
  NativeHelperConfiguration,
} from "../../src/screen-observation/types.js";

const configuration = {
  activityMonitoring: {
    coalescingIntervalMilliseconds: 250,
  },
  accessibility: {
    maxDepth: 40,
    maxNodes: 5_000,
    timeoutMilliseconds: 2_000,
    maxTextLength: 8_192,
  },
  screenshot: {
    maxWidth: 1_920,
    jpegQuality: 0.85,
  },
  visualMonitoring: {
    maxWidth: 320,
    sampleIntervalMilliseconds: 500,
    queueDepth: 2,
    changeThreshold: 0.015,
    signatureWidth: 32,
    signatureHeight: 18,
  },
  windowSelection: {
    minimumWidth: 160,
    minimumHeight: 120,
    maximumAspectRatio: 4,
  },
} satisfies NativeHelperConfiguration;

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
  protocolVersion: 3,
  type: "ready",
  processIdentifier: process.pid,
}) + "\\n");
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  const command = JSON.parse(line);
  if (command.type === "configure") {
    if (
      command.configuration.accessibility.maxDepth !== 40 ||
      command.configuration.activityMonitoring.coalescingIntervalMilliseconds !== 250
    ) process.exit(2);
    process.stdout.write(JSON.stringify({
      protocolVersion: 3,
      requestId: command.requestId,
      type: "configured",
    }) + "\\n");
    process.stdout.write(JSON.stringify({
      protocolVersion: 3,
      type: "signal",
      signal: ${JSON.stringify(testSignal)},
    }) + "\\n");
  }
  if (command.type === "capture") {
    process.stdout.write(JSON.stringify({
      protocolVersion: 3,
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
    configuration,
    configurationTimeoutMilliseconds: 2_000,
    captureTimeoutMilliseconds: 2_000,
    shutdownTimeoutMilliseconds: 500,
    onSignal: (signal) => signals.push(signal),
    onLifecycle: (state: string) => states.push(state),
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

test("reports a crashed helper without restarting it", async (t) => {
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
      protocolVersion: 3,
      type: "ready",
      processIdentifier: process.pid,
    }) + "\\n");
    process.stdin.once("data", (data) => {
      const command = JSON.parse(String(data).trim());
      process.stdout.write(JSON.stringify({
        protocolVersion: 3,
        requestId: command.requestId,
        type: "configured",
      }) + "\\n");
      setTimeout(() => process.exit(1), 5);
    });
  `);
  const states: string[] = [];
  const fatalErrors: Error[] = [];
  const options = {
    command: process.execPath,
    arguments: [helperPath],
    environment: { ...process.env, HELPER_COUNT_PATH: countPath },
    excludedProcessIdentifiers: [],
    excludedBundleIdentifiers: [],
    configuration,
    configurationTimeoutMilliseconds: 2_000,
    captureTimeoutMilliseconds: 2_000,
    shutdownTimeoutMilliseconds: 500,
    onSignal: () => {},
    onLifecycle: (state: string) => states.push(state),
    onFatalError: (error: Error) => fatalErrors.push(error),
  };
  const client = new NativeHelperClient(options);
  t.after(() => client.stop());

  await client.start();
  await waitFor(() => fatalErrors.length === 1);
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.equal(await readFile(countPath, "utf8"), "1");
  assert.equal(states.at(-1), "failed");
  assert.match(fatalErrors[0]!.message, /exited/);
  assert.equal(client.running, false);
});

test("times out only the stalled capture and accepts another capture", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openscreen-helper-capture-timeout-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const helperPath = join(directory, "capture-timeout-helper.mjs");
  await writeFile(helperPath, `
    import { createInterface } from "node:readline";
    process.stdout.write(JSON.stringify({
      protocolVersion: 3,
      type: "ready",
      processIdentifier: process.pid,
    }) + "\\n");
    let captures = 0;
    const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
    for await (const line of lines) {
      const command = JSON.parse(line);
      if (command.type === "configure") {
        process.stdout.write(JSON.stringify({
          protocolVersion: 3,
          requestId: command.requestId,
          type: "configured",
        }) + "\\n");
      }
      if (command.type === "capture") {
        captures += 1;
        if (captures === 1) continue;
        process.stdout.write(JSON.stringify({
          protocolVersion: 3,
          requestId: command.requestId,
          type: "captureResult",
          result: {
            capturedAt: "2026-07-27T00:00:01.000Z",
            window: command.signal.window,
            screenshot: { status: "failed", durationMilliseconds: 1 },
            accessibility: { status: "failed", durationMilliseconds: 1 },
          },
        }) + "\\n");
      }
      if (command.type === "shutdown") process.exit(0);
    }
  `);
  const options = {
    command: process.execPath,
    arguments: [helperPath],
    excludedProcessIdentifiers: [],
    excludedBundleIdentifiers: [],
    configuration,
    configurationTimeoutMilliseconds: 2_000,
    captureTimeoutMilliseconds: 20,
    shutdownTimeoutMilliseconds: 100,
    onSignal: () => {},
  };
  const client = new NativeHelperClient(options);
  t.after(() => client.stop());

  await client.start();
  await assert.rejects(
    Promise.race([
      client.capture(testSignal),
      new Promise((_, reject) => setTimeout(
        () => reject(new Error("Capture timeout test guard expired")),
        500,
      )),
    ]),
    /Observation helper capture timed out/,
  );
  const result = await client.capture(testSignal);

  assert.equal(result.screenshot.status, "failed");
  assert.equal(client.running, true);
});

test("forwards component status without degrading the helper", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openscreen-helper-status-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const helperPath = join(directory, "status-helper.mjs");
  await writeFile(helperPath, `
    import { createInterface } from "node:readline";
    process.stdout.write(JSON.stringify({
      protocolVersion: 3,
      type: "ready",
      processIdentifier: process.pid,
    }) + "\\n");
    const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
    for await (const line of lines) {
      const command = JSON.parse(line);
      if (command.type === "configure") {
        process.stdout.write(JSON.stringify({
          protocolVersion: 3,
          requestId: command.requestId,
          type: "configured",
        }) + "\\n");
        process.stdout.write(JSON.stringify({
          protocolVersion: 3,
          type: "status",
          component: "accessibility",
          status: "degraded",
          message: "Permission unavailable",
        }) + "\\n");
      }
      if (command.type === "shutdown") process.exit(0);
    }
  `);
  const statuses: unknown[] = [];
  const options = {
    command: process.execPath,
    arguments: [helperPath],
    excludedProcessIdentifiers: [],
    excludedBundleIdentifiers: [],
    configuration,
    configurationTimeoutMilliseconds: 2_000,
    captureTimeoutMilliseconds: 2_000,
    shutdownTimeoutMilliseconds: 100,
    onSignal: () => {},
    onComponentStatus: (status: unknown) => statuses.push(status),
  };
  const client = new NativeHelperClient(options);
  t.after(() => client.stop());

  await client.start();
  await waitFor(() => statuses.length === 1);

  assert.deepEqual(statuses, [{
    protocolVersion: 3,
    type: "status",
    component: "accessibility",
    status: "degraded",
    message: "Permission unavailable",
  }]);
  assert.equal(client.running, true);
});

test("ignores non-JSON stdout diagnostics before readiness", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openscreen-helper-diagnostic-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const helperPath = join(directory, "diagnostic-helper.mjs");
  await writeFile(helperPath, `
    import { createInterface } from "node:readline";
    process.stdout.write("framework diagnostic\\n");
    process.stdout.write(JSON.stringify({
      protocolVersion: 3,
      type: "ready",
      processIdentifier: process.pid,
    }) + "\\n");
    const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
    for await (const line of lines) {
      const command = JSON.parse(line);
      if (command.type === "configure") {
        process.stdout.write(JSON.stringify({
          protocolVersion: 3,
          requestId: command.requestId,
          type: "configured",
        }) + "\\n");
      }
      if (command.type === "shutdown") process.exit(0);
    }
  `);
  const client = new NativeHelperClient({
    command: process.execPath,
    arguments: [helperPath],
    excludedProcessIdentifiers: [],
    excludedBundleIdentifiers: [],
    configuration,
    configurationTimeoutMilliseconds: 2_000,
    captureTimeoutMilliseconds: 2_000,
    shutdownTimeoutMilliseconds: 100,
    onSignal: () => {},
  });
  t.after(() => client.stop());

  await client.start();

  assert.equal(client.running, true);
});

test("fails fast on an incompatible structured protocol message", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openscreen-helper-protocol-error-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const helperPath = join(directory, "protocol-error-helper.mjs");
  await writeFile(helperPath, `
    process.stdout.write(JSON.stringify({
      protocolVersion: 999,
      type: "ready",
      processIdentifier: process.pid,
    }) + "\\n");
    process.stdin.resume();
  `);
  const fatalErrors: Error[] = [];
  const states: string[] = [];
  const client = new NativeHelperClient({
    command: process.execPath,
    arguments: [helperPath],
    excludedProcessIdentifiers: [],
    excludedBundleIdentifiers: [],
    configuration,
    configurationTimeoutMilliseconds: 2_000,
    captureTimeoutMilliseconds: 2_000,
    shutdownTimeoutMilliseconds: 100,
    onSignal: () => {},
    onLifecycle: (state: string) => states.push(state),
    onFatalError: (error: Error) => fatalErrors.push(error),
  });
  t.after(() => client.stop());

  await assert.rejects(client.start(), /Unsupported helper protocol version/);

  assert.equal(client.running, false);
  assert.equal(states.at(-1), "failed");
  assert.match(fatalErrors[0]!.message, /Unsupported helper protocol version/);
});

test("rejects a malformed capture result without failing the helper", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openscreen-helper-malformed-capture-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const helperPath = join(directory, "malformed-capture-helper.mjs");
  await writeFile(helperPath, `
    import { createInterface } from "node:readline";
    process.stdout.write(JSON.stringify({
      protocolVersion: 3,
      type: "ready",
      processIdentifier: process.pid,
    }) + "\\n");
    const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
    for await (const line of lines) {
      const command = JSON.parse(line);
      if (command.type === "configure") {
        process.stdout.write(JSON.stringify({
          protocolVersion: 3,
          requestId: command.requestId,
          type: "configured",
        }) + "\\n");
      }
      if (command.type === "capture") {
        process.stdout.write(JSON.stringify({
          protocolVersion: 3,
          requestId: command.requestId,
          type: "captureResult",
          result: { capturedAt: "not-a-date" },
        }) + "\\n");
      }
      if (command.type === "shutdown") process.exit(0);
    }
  `);
  const client = new NativeHelperClient({
    command: process.execPath,
    arguments: [helperPath],
    excludedProcessIdentifiers: [],
    excludedBundleIdentifiers: [],
    configuration,
    configurationTimeoutMilliseconds: 2_000,
    captureTimeoutMilliseconds: 2_000,
    shutdownTimeoutMilliseconds: 100,
    onSignal: () => {},
  });
  t.after(() => client.stop());

  await client.start();
  await assert.rejects(client.capture(testSignal), /Invalid helper capture result/);

  assert.equal(client.running, true);
});

test("can be explicitly started after a clean stop", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openscreen-helper-restart-explicit-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const countPath = join(directory, "count.txt");
  const helperPath = join(directory, "restartable-helper.mjs");
  await writeFile(helperPath, `
    import { readFileSync, writeFileSync } from "node:fs";
    import { createInterface } from "node:readline";
    const path = process.env.HELPER_COUNT_PATH;
    let count = 0;
    try { count = Number(readFileSync(path, "utf8")); } catch {}
    writeFileSync(path, String(count + 1));
    process.stdout.write(JSON.stringify({
      protocolVersion: 3,
      type: "ready",
      processIdentifier: process.pid,
    }) + "\\n");
    const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
    for await (const line of lines) {
      const command = JSON.parse(line);
      if (command.type === "configure") {
        process.stdout.write(JSON.stringify({
          protocolVersion: 3,
          requestId: command.requestId,
          type: "configured",
        }) + "\\n");
      }
      if (command.type === "shutdown") process.exit(0);
    }
  `);
  const client = new NativeHelperClient({
    command: process.execPath,
    arguments: [helperPath],
    environment: { ...process.env, HELPER_COUNT_PATH: countPath },
    excludedProcessIdentifiers: [],
    excludedBundleIdentifiers: [],
    configuration,
    configurationTimeoutMilliseconds: 2_000,
    captureTimeoutMilliseconds: 2_000,
    shutdownTimeoutMilliseconds: 100,
    onSignal: () => {},
  });
  t.after(() => client.stop());

  await client.start();
  await client.stop();
  await client.start();

  assert.equal(client.running, true);
  assert.equal(await readFile(countPath, "utf8"), "2");
});

test("rejects startup when the helper rejects configuration", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openscreen-helper-config-error-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const helperPath = join(directory, "rejecting-helper.mjs");
  await writeFile(helperPath, `
    import { createInterface } from "node:readline";
    process.stdout.write(JSON.stringify({
      protocolVersion: 3,
      type: "ready",
      processIdentifier: process.pid,
    }) + "\\n");
    const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
    for await (const line of lines) {
      const command = JSON.parse(line);
      process.stdout.write(JSON.stringify({
        protocolVersion: 3,
        type: "error",
        requestId: command.requestId,
        code: "invalid_configuration",
        message: "Configuration rejected",
      }) + "\\n");
    }
  `);
  const client = new NativeHelperClient({
    command: process.execPath,
    arguments: [helperPath],
    excludedProcessIdentifiers: [],
    excludedBundleIdentifiers: [],
    configuration,
    configurationTimeoutMilliseconds: 200,
    captureTimeoutMilliseconds: 2_000,
    shutdownTimeoutMilliseconds: 100,
    onSignal: () => {},
  });
  t.after(() => client.stop());

  await assert.rejects(
    Promise.race([
      client.start(),
      new Promise<void>((_, reject) => setTimeout(
        () => reject(new Error("Test timed out waiting for configuration rejection")),
        2_000,
      )),
    ]),
    /invalid_configuration: Configuration rejected/,
  );
});

test("times out a helper that never acknowledges configuration", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openscreen-helper-config-timeout-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const helperPath = join(directory, "silent-helper.mjs");
  await writeFile(helperPath, `
    process.stdout.write(JSON.stringify({
      protocolVersion: 3,
      type: "ready",
      processIdentifier: process.pid,
    }) + "\\n");
    process.stdin.resume();
  `);
  const client = new NativeHelperClient({
    command: process.execPath,
    arguments: [helperPath],
    excludedProcessIdentifiers: [],
    excludedBundleIdentifiers: [],
    configuration,
    configurationTimeoutMilliseconds: 20,
    captureTimeoutMilliseconds: 2_000,
    shutdownTimeoutMilliseconds: 100,
    onSignal: () => {},
  });
  t.after(() => client.stop());

  await assert.rejects(
    Promise.race([
      client.start(),
      new Promise<void>((_, reject) => setTimeout(
        () => reject(new Error("Test timed out waiting for helper timeout")),
        2_000,
      )),
    ]),
    /configuration timed out/,
  );
});

async function waitFor(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 2_000;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for helper state");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
