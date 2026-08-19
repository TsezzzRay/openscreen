import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  appendMemoryDiagnostic,
  memoryDiagnosticsLogPath,
} from "../../src/memory/diagnostics-log.js";

test("records the phase and the full message, one line per diagnostic", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-diagnostics-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  appendMemoryDiagnostic(root, "chronicle", "Invalid Chronicle activity summary", 0);
  appendMemoryDiagnostic(root, "start", "MINIMAX_CN_API_KEY is required", 1_000);

  const content = await readFile(memoryDiagnosticsLogPath(root), "utf8");
  const lines = content.trimEnd().split("\n");
  assert.equal(lines.length, 2);
  assert.equal(lines[0], "1970-01-01T00:00:00.000Z chronicle Invalid Chronicle activity summary");
  assert.equal(lines[1], "1970-01-01T00:00:01.000Z start MINIMAX_CN_API_KEY is required");
});

test("collapses newlines so one diagnostic stays one greppable line", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-diagnostics-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  appendMemoryDiagnostic(root, "worker", "first line\nsecond line\r\nthird", 0);

  const content = await readFile(memoryDiagnosticsLogPath(root), "utf8");
  assert.equal(content.trimEnd().split("\n").length, 1);
  assert.match(content, /first line second line third/);
});

test("creates the log 0600 inside a 0700 root", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-diagnostics-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  appendMemoryDiagnostic(root, "scan", "boom", 0);

  const info = await stat(memoryDiagnosticsLogPath(root));
  assert.equal(info.mode & 0o777, 0o600);
});

test("truncates instead of growing without bound", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-diagnostics-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = memoryDiagnosticsLogPath(root);

  // Exactly at the cap, so any appended line must push it over.
  await writeFile(path, "x".repeat(1_048_576), { mode: 0o600 });
  appendMemoryDiagnostic(root, "retention", "after the cap", 0);

  const info = await stat(path);
  assert.ok(info.size < 1_048_576, `expected truncation, got ${info.size} bytes`);
  const content = await readFile(path, "utf8");
  assert.match(content, /log truncated at 1048576 bytes/);
  assert.match(content, /retention after the cap/);
});

test("never throws, even when the root cannot be written", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-diagnostics-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  // A path whose parent is a file, so mkdir/append cannot succeed.
  const blocked = join(root, "file", "nested");
  await writeFile(join(root, "file"), "not a directory");

  assert.doesNotThrow(() => appendMemoryDiagnostic(blocked, "start", "unreachable", 0));
});
