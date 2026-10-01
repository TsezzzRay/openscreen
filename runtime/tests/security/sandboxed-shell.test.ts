import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { link, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SandboxedToolShell } from "../../src/security/sandboxed-shell.js";
import { shellQuote } from "../../src/agent/pi/tools/tool-support.js";

function globalPointerProbeEnabled(platform: string, environment: NodeJS.ProcessEnv): boolean {
  return platform === "darwin"
    && environment.OPENSCREEN_DESKTOP_SECURITY_PROBE === "1"
    && environment.OPENSCREEN_ISOLATED_DESKTOP === "1";
}

test("global pointer probes require an isolated desktop declaration", () => {
  assert.equal(globalPointerProbeEnabled("darwin", {}), false);
  assert.equal(globalPointerProbeEnabled("darwin", { OPENSCREEN_DESKTOP_SECURITY_PROBE: "1" }), false);
  assert.equal(globalPointerProbeEnabled("darwin", { OPENSCREEN_ISOLATED_DESKTOP: "1" }), false);
  assert.equal(globalPointerProbeEnabled("darwin", {
    OPENSCREEN_DESKTOP_SECURITY_PROBE: "1", OPENSCREEN_ISOLATED_DESKTOP: "1",
  }), true);
  assert.equal(globalPointerProbeEnabled("linux", {
    OPENSCREEN_DESKTOP_SECURITY_PROBE: "1", OPENSCREEN_ISOLATED_DESKTOP: "1",
  }), false);
  assert.equal(globalPointerProbeEnabled("darwin", {
    OPENSCREEN_DESKTOP_SECURITY_PROBE: "1", OPENSCREEN_ISOLATED_DESKTOP: "true",
  }), false);
});

test("shell reads broadly, writes only to task output, and cannot use network", { skip: process.platform !== "darwin" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-security-"));
  const output = join(root, "output");
  await mkdir(output);
  const shell = new SandboxedToolShell({ cwd: root, outputRoot: output });
  try {
    const readable = await shell.exec("test -r /etc/hosts");
    assert.equal(readable.ok && readable.value.exitCode, 0);
    const allowed = await shell.exec("printf allowed > output/result.txt");
    assert.equal(allowed.ok && allowed.value.exitCode, 0);
    assert.equal(await readFile(join(output, "result.txt"), "utf8"), "allowed");
    const denied = await shell.exec("printf denied > blocked.txt");
    assert.notEqual(denied.ok && denied.value.exitCode, 0);
    await assert.rejects(readFile(join(root, "blocked.txt")));
    const network = await shell.exec("/usr/bin/curl --max-time 2 -sS https://example.com");
    assert.notEqual(network.ok && network.value.exitCode, 0);
  } finally {
    await shell.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});

test("shell cannot signal a process outside its sandbox", { skip: process.platform !== "darwin" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-signal-security-"));
  const output = join(root, "output");
  await mkdir(output);
  const sleeper = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
  const shell = new SandboxedToolShell({ cwd: root, outputRoot: output });
  try {
    assert.ok(sleeper.pid);
    const result = await shell.exec(`kill -0 ${sleeper.pid}`);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.notEqual(result.value.exitCode, 0);
      assert.match(result.value.stderr, /Operation not permitted/);
    }
    assert.equal(sleeper.exitCode, null, "the external process must remain running");
  } finally {
    if (sleeper.exitCode === null) {
      const exited = new Promise<void>(resolve => { sleeper.once("exit", () => resolve()); });
      sleeper.kill();
      await exited;
    }
    await shell.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});

test("shell cannot modify an outside file through an output-directory hard link", { skip: process.platform !== "darwin" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-security-"));
  const output = join(root, "output");
  const outside = join(root, "outside.txt");
  await mkdir(output);
  await writeFile(outside, "original");
  await link(outside, join(output, "alias.txt"));
  const shell = new SandboxedToolShell({ cwd: root, outputRoot: output });
  try {
    const result = await shell.exec("printf changed > output/alias.txt");
    assert.notEqual(result.ok && result.value.exitCode, 0);
    assert.equal(await readFile(outside, "utf8"), "original");
  } finally {
    await shell.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});

test("shell cannot create a hard link from outside into task output", { skip: process.platform !== "darwin" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-security-"));
  const output = join(root, "output");
  await mkdir(output);
  await writeFile(join(root, "outside.txt"), "original");
  const shell = new SandboxedToolShell({ cwd: root, outputRoot: output });
  try {
    const result = await shell.exec("ln outside.txt output/alias.txt");
    assert.notEqual(result.ok && result.value.exitCode, 0);
    await assert.rejects(readFile(join(output, "alias.txt")));
  } finally {
    await shell.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});

test("shell permits hard links wholly inside task output", { skip: process.platform !== "darwin" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-security-"));
  const output = join(root, "output");
  await mkdir(output);
  await writeFile(join(output, "original.txt"), "original");
  await link(join(output, "original.txt"), join(output, "alias.txt"));
  const shell = new SandboxedToolShell({ cwd: root, outputRoot: output });
  try {
    const result = await shell.exec("printf changed > output/alias.txt");
    assert.equal(result.ok && result.value.exitCode, 0);
    assert.equal(await readFile(join(output, "original.txt"), "utf8"), "changed");
  } finally {
    await shell.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});

test("shell cannot move the real desktop pointer through the installed CUA SDK", {
  skip: !globalPointerProbeEnabled(process.platform, process.env),
}, async (context) => {
  const { CuaDriver, currentMacOsPermissionStatus } = await import("@trycua/cua-driver");
  if (!currentMacOsPermissionStatus().accessibility) {
    context.skip("Accessibility permission is required to exercise the desktop mutation path");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "openscreen-desktop-security-"));
  const output = join(root, "output");
  await mkdir(output);
  const host = CuaDriver.create(undefined);
  const shell = new SandboxedToolShell({ cwd: process.cwd(), outputRoot: output });
  let initial: { x: number; y: number } | undefined;
  try {
    const before = await host.getCursorPosition({});
    assert.equal(before.isError, false);
    assert.ok(before.structuredJson);
    initial = JSON.parse(before.structuredJson) as { x: number; y: number };
    const nextX = initial.x > 0 ? initial.x - 1 : initial.x + 1;
    const script = `
      import { CuaDriver, ActionTarget } from "@trycua/cua-driver";
      const driver = CuaDriver.create(undefined);
      try {
        const result = await driver.moveCursor({
          x: ${nextX}, y: ${initial.y},
          target: ActionTarget.Desktop.new({ displayId: "primary" }),
        });
        console.log(JSON.stringify({ isError: result.isError, text: result.text }));
      } finally {
        await driver.shutdown();
        driver.uniffiDestroy();
      }
    `;
    const result = await shell.exec(`${shellQuote(process.execPath)} --input-type=module -e ${shellQuote(script)}`, { timeout: 10_000 });
    const after = await host.getCursorPosition({});
    assert.equal(after.isError, false);
    assert.ok(after.structuredJson);
    assert.deepEqual(JSON.parse(after.structuredJson), initial, "sandboxed CUA changed the desktop pointer");
    if (result.ok) assert.doesNotMatch(result.value.stdout, /Moved the real desktop pointer/);
  } finally {
    if (initial) {
      spawnSync("/usr/bin/swift", ["-e", `import ApplicationServices; _ = CGWarpMouseCursorPosition(CGPoint(x: ${initial.x}, y: ${initial.y}))`], { stdio: "ignore" });
    }
    await host.shutdown();
    if ("uniffiDestroy" in host && typeof host.uniffiDestroy === "function") host.uniffiDestroy();
    await shell.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});

test("shell cannot warp the real desktop pointer through CoreGraphics", {
  skip: !globalPointerProbeEnabled(process.platform, process.env),
}, async (context) => {
  const { CuaDriver, currentMacOsPermissionStatus } = await import("@trycua/cua-driver");
  if (!currentMacOsPermissionStatus().accessibility) {
    context.skip("Accessibility permission is required to exercise the desktop mutation path");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "openscreen-quartz-security-"));
  const output = join(root, "output");
  await mkdir(output);
  const binary = join(output, "warp-cursor");
  const source = `#include <ApplicationServices/ApplicationServices.h>
#include <stdlib.h>
int main(int argc, char **argv) {
  if (argc != 3) return 2;
  return CGWarpMouseCursorPosition(CGPointMake(atof(argv[1]), atof(argv[2])));
}
`;
  const build = spawnSync("/usr/bin/clang", ["-x", "c", "-framework", "ApplicationServices", "-o", binary, "-"], {
    input: source,
    encoding: "utf8",
  });
  assert.equal(build.status, 0, build.stderr);
  const host = CuaDriver.create(undefined);
  const shell = new SandboxedToolShell({ cwd: root, outputRoot: output });
  let initial: { x: number; y: number } | undefined;
  try {
    const position = async () => {
      const result = await host.getCursorPosition({});
      assert.equal(result.isError, false);
      assert.ok(result.structuredJson);
      return JSON.parse(result.structuredJson) as { x: number; y: number };
    };
    initial = await position();
    const nextX = initial.x > 0 ? initial.x - 1 : initial.x + 1;
    const control = spawnSync(binary, [String(nextX), String(initial.y)]);
    assert.equal(control.status, 0, "host control must be able to move the pointer");
    assert.equal((await position()).x, nextX);
    const restore = spawnSync(binary, [String(initial.x), String(initial.y)]);
    assert.equal(restore.status, 0);
    assert.deepEqual(await position(), initial);
    const sandboxed = await shell.exec(`${shellQuote(binary)} ${nextX} ${initial.y}`, { timeout: 5_000 });
    assert.notEqual(sandboxed.ok && sandboxed.value.exitCode, 0);
    assert.deepEqual(await position(), initial, "sandboxed CoreGraphics changed the desktop pointer");
  } finally {
    if (initial) spawnSync(binary, [String(initial.x), String(initial.y)], { stdio: "ignore" });
    await host.shutdown();
    if ("uniffiDestroy" in host && typeof host.uniffiDestroy === "function") host.uniffiDestroy();
    await shell.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});
