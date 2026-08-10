import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { executeToolCalls } from "../../src/tools/executor.js";
import { createBashTool } from "../../src/tools/system/bash.js";
import { createEditTool } from "../../src/tools/system/edit.js";
import { createWriteTool } from "../../src/tools/system/write.js";

const signal = new AbortController().signal;

test("write creates parents and returns a summary instead of file content", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openscreen-write-"));
  const write = createWriteTool(directory);
  const result = await write.execute({
    path: "nested/file.txt",
    content: "甲乙",
  }, signal) as any;

  assert.equal(await readFile(join(directory, "nested/file.txt"), "utf8"), "甲乙");
  assert.equal(result.content, "Successfully wrote 6 bytes to nested/file.txt");
  assert.deepEqual(result.details, { bytesWritten: 6 });
  assert.doesNotMatch(result.content, /甲乙/);
});

test("write serializes concurrent mutations targeting the same file", async () => {
  const order: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let firstStarted!: () => void;
  const started = new Promise<void>((resolve) => { firstStarted = resolve; });
  const write = createWriteTool("/workspace", {
    mkdir: async () => {},
    writeFile: async (_path, content) => {
      order.push(`${content}:start`);
      if (content === "first") {
        firstStarted();
        await gate;
      }
      order.push(`${content}:end`);
    },
  });

  const first = write.execute({ path: "same.txt", content: "first" }, signal);
  const second = write.execute({ path: "same.txt", content: "second" }, signal);
  await started;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["first:start"]);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first:start", "first:end", "second:start", "second:end"]);
});

test("edit applies disjoint exact replacements against the original and preserves CRLF and BOM", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openscreen-edit-"));
  const path = join(directory, "file.txt");
  await createWriteTool(directory).execute({
    path,
    content: "\uFEFFalpha\r\nbeta\r\ngamma\r\n",
  }, signal);
  const edit = createEditTool(directory);
  const result = await edit.execute({
    path,
    edits: [
      { oldText: "alpha\nbeta", newText: "one\ntwo" },
      { oldText: "gamma", newText: "three" },
    ],
  }, signal) as any;

  assert.equal(await readFile(path, "utf8"), "\uFEFFone\r\ntwo\r\nthree\r\n");
  assert.equal(result.content, `Successfully replaced 2 blocks in ${path}`);
  assert.equal(result.details.replacements, 2);
  assert.doesNotMatch(result.content, /one|two|three/);
});

test("edit rejects ambiguous and overlapping replacements without writing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openscreen-edit-"));
  const path = join(directory, "file.txt");
  await createWriteTool(directory).execute({ path, content: "same same" }, signal);
  const edit = createEditTool(directory);

  await assert.rejects(
    edit.execute({ path, edits: [{ oldText: "same", newText: "new" }] }, signal),
    /Found 2 occurrences/,
  );
  assert.equal(await readFile(path, "utf8"), "same same");
  const overlapPath = join(directory, "overlap.txt");
  await createWriteTool(directory).execute({
    path: overlapPath,
    content: "alpha beta gamma",
  }, signal);
  await assert.rejects(
    edit.execute({
      path: overlapPath,
      edits: [
        { oldText: "alpha beta", newText: "one" },
        { oldText: "beta gamma", newText: "two" },
      ],
    }, signal),
    /overlap/,
  );
  assert.equal(await readFile(overlapPath, "utf8"), "alpha beta gamma");
});

test("bash keeps the output tail and persists complete output under the configured data path", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openscreen-bash-"));
  const outputDirectory = join(directory, "audit-output");
  const bash = createBashTool(directory, outputDirectory);
  const result = await bash.execute({
    command: "node -e 'for (let i = 0; i < 3000; i++) console.log(`line-${i}`)'",
  }, signal) as any;

  assert.match(result.content, /^line-1000\n/);
  assert.match(result.content, /line-2999/);
  assert.match(result.content, /\[Showing lines 1001-3000 of 3000\. Full output:/);
  assert.equal(result.details.exitCode, 0);
  assert.equal(result.details.truncation.truncatedBy, "lines");
  const full = await readFile(result.details.fullOutputPath, "utf8");
  assert.match(full, /^line-0\n/);
  assert.match(full, /line-2999\n$/);
});

test("bash non-zero exits are model-visible failures with audited output and exit code", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openscreen-bash-"));
  const bash = createBashTool(directory, join(directory, "audit-output"));
  const events: any[] = [];
  const executions = await executeToolCalls([{
    id: "call-item",
    call_id: "call-1",
    type: "function_call",
    status: "completed",
    name: "bash",
    arguments: JSON.stringify({ command: "printf 'problem\\n'; exit 7" }),
  }], [bash], 1, signal, async (event) => { events.push(event); });

  assert.match(executions[0].resultItem.output as string, /problem/);
  assert.match(executions[0].resultItem.output as string, /Command exited with code 7/);
  const finished = events.find((event) => event.type === "tool_call_finished");
  assert.equal(finished.status, "failed");
  assert.equal(finished.details.exitCode, 7);
});

test("bash timeout terminates the command and records a failed outcome", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openscreen-bash-"));
  const bash = createBashTool(directory, join(directory, "audit-output"));
  const events: any[] = [];
  const startedAt = Date.now();
  const executions = await executeToolCalls([{
    id: "call-item",
    call_id: "call-1",
    type: "function_call",
    status: "completed",
    name: "bash",
    arguments: JSON.stringify({ command: "sleep 5", timeout: 0.01 }),
  }], [bash], 1, signal, async (event) => { events.push(event); });

  assert.ok(Date.now() - startedAt < 1_500);
  assert.match(executions[0].resultItem.output as string, /timed out after 0\.01 seconds/);
  const finished = events.find((event) => event.type === "tool_call_finished");
  assert.equal(finished.status, "failed");
  assert.equal(finished.details.timeoutSeconds, 0.01);
});

test("bash records a failed outcome when its sidecar directory cannot be created", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openscreen-bash-"));
  const outputDirectory = join(directory, "audit-output");
  await writeFile(outputDirectory, "not a directory");
  const bash = createBashTool(directory, outputDirectory);
  const events: any[] = [];
  const executions = await executeToolCalls([{
    id: "call-item",
    call_id: "call-1",
    type: "function_call",
    status: "completed",
    name: "bash",
    arguments: JSON.stringify({
      command: "node -e 'process.stdout.write(`x`.repeat(60000))'",
    }),
  }], [bash], 1, signal, async (event) => { events.push(event); });

  assert.match(executions[0].resultItem.output as string, /EEXIST|not a directory/);
  assert.deepEqual(events.map((event) => event.type), [
    "tool_call_started",
    "tool_call_finished",
  ]);
  assert.equal(events[1].status, "failed");
});
