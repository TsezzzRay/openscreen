import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { Value } from "typebox/value";

import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import {
  AgentHarness,
  InMemorySessionRepo,
  type AgentTool,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";

import { createAgentTools } from "../../../src/agent/pi/tools/create-agent-tools.js";

async function runtime(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "openscreen-pi-tools-"));
  const env = new NodeExecutionEnv({ cwd: root });
  t.after(async () => env.cleanup());
  return { root, env, tools: createAgentTools(env) };
}

function tool(tools: AgentTool[], name: string): AgentTool {
  const found = tools.find((candidate) => candidate.name === name);
  assert.ok(found, `missing ${name} tool`);
  return found;
}

async function invoke(
  tools: AgentTool[],
  name: string,
  params: Record<string, unknown>,
  signal = new AbortController().signal,
) {
  return tool(tools, name).execute(`test-${name}`, params, signal);
}

function text(result: Awaited<ReturnType<typeof invoke>>): string {
  return result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

test("factory exposes the seven canonical tools and serializes mutations", async (t) => {
  const { tools } = await runtime(t);

  assert.deepEqual(
    tools.map((candidate) => candidate.name),
    ["read", "ls", "grep", "find", "write", "edit", "bash"],
  );
  assert.equal(tool(tools, "write").executionMode, "sequential");
  assert.equal(tool(tools, "edit").executionMode, "sequential");
  assert.equal(tool(tools, "bash").executionMode, "sequential");
  assert.equal(tool(tools, "read").executionMode, undefined);
});

test("AgentHarness validates and executes canonical write and read tool calls", async (t) => {
  const { root, env, tools } = await runtime(t);
  const faux = fauxProvider({
    provider: `faux-pi-tools-${Math.random().toString(36).slice(2)}`,
  });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage([
      fauxToolCall("write", { path: "nested/note.txt", content: "from harness" }),
      fauxToolCall("read", { path: "nested/note.txt" }),
    ]),
    fauxAssistantMessage("done"),
  ]);
  const session = await new InMemorySessionRepo().create();
  const harness = new AgentHarness({
    env,
    session,
    models,
    model: faux.getModel(),
    tools,
  });

  await harness.prompt("write then read");

  assert.equal(await readFile(join(root, "nested/note.txt"), "utf8"), "from harness");
  const toolResults = (await session.getBranch())
    .filter((entry) => entry.type === "message" && entry.message.role === "toolResult")
    .map((entry) => entry.type === "message" ? entry.message : undefined);
  assert.equal(toolResults.length, 2);
  assert.match(JSON.stringify(toolResults[1]), /from harness/);
});

test("AgentHarness rejects invalid mutation arguments before execution", async (t) => {
  const { root, env, tools } = await runtime(t);
  const faux = fauxProvider({
    provider: `faux-pi-tools-schema-${Math.random().toString(36).slice(2)}`,
  });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("write", { path: "should-not-exist.txt" })),
    fauxAssistantMessage("done"),
  ]);
  const session = await new InMemorySessionRepo().create();
  const harness = new AgentHarness({
    env,
    session,
    models,
    model: faux.getModel(),
    tools,
  });

  await harness.prompt("invalid write");

  await assert.rejects(readFile(join(root, "should-not-exist.txt")), /ENOENT/);
  const result = (await session.getBranch())
    .filter((entry) => entry.type === "message")
    .map((entry) => entry.type === "message" ? entry.message : undefined)
    .find((message) => message?.role === "toolResult");
  assert.ok(result?.role === "toolResult");
  assert.equal(result.isError, true);
  assert.match(
    result.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join(""),
    /Validation failed for tool "write":[\s\S]*content: must have required properties content/,
  );
});

test("read supports 1-indexed offsets and pi head truncation notices", async (t) => {
  const { root, tools } = await runtime(t);
  const path = join(root, "large.txt");
  await writeFile(
    path,
    Array.from({ length: 2_002 }, (_, index) => `line-${index + 1}`).join("\n"),
  );

  const first = await invoke(tools, "read", { path: "large.txt" });
  assert.match(text(first), /^line-1\nline-2/);
  assert.match(text(first), /Showing lines 1-2000 of 2002/);
  assert.equal((first.details as { truncation?: { truncatedBy: string } }).truncation?.truncatedBy, "lines");

  const continued = await invoke(tools, "read", {
    path: "large.txt",
    offset: 2_001,
    limit: 1,
  });
  assert.match(text(continued), /^line-2001/);
  assert.match(text(continued), /offset=2002/);
});

test("read does not count a terminal newline as an extra line", async (t) => {
  const { root, tools } = await runtime(t);
  const content = Array.from({ length: 2_000 }, (_, index) => `line-${index + 1}`).join("\n") + "\n";
  await writeFile(join(root, "exact.txt"), content);

  const result = await invoke(tools, "read", { path: "exact.txt" });

  assert.equal(text(result), content);
  assert.equal((result.details as { linesReturned: number }).linesReturned, 2_000);
  assert.doesNotMatch(text(result), /Showing lines|more lines/);
});

test("write creates parents and edit requires unique exact text", async (t) => {
  const { root, tools } = await runtime(t);

  const written = await invoke(tools, "write", {
    path: "deep/file.txt",
    content: "alpha\nbeta\n",
  });
  assert.match(text(written), /Successfully wrote/);
  const edited = await invoke(tools, "edit", {
    path: "deep/file.txt",
    edits: [{ oldText: "beta", newText: "gamma" }],
  });
  assert.match(text(edited), /Successfully replaced 1 block/);
  assert.equal(await readFile(join(root, "deep/file.txt"), "utf8"), "alpha\ngamma\n");

  await writeFile(join(root, "duplicates.txt"), "same\nsame\n");
  await assert.rejects(
    invoke(tools, "edit", {
      path: "duplicates.txt",
      edits: [{ oldText: "same", newText: "different" }],
    }),
    /2 occurrences.*must be unique/,
  );
});

test("ls, grep, and find are bounded and respect ignore files", async (t) => {
  const { root, tools } = await runtime(t);
  await mkdir(join(root, "src"));
  await mkdir(join(root, "ignored"));
  await mkdir(join(root, ".git"));
  await writeFile(join(root, ".gitignore"), "ignored/\n");
  await writeFile(join(root, "src", "visible.ts"), "const marker = 'visible';\n");
  await writeFile(join(root, "src", "second.ts"), "const marker = 'second';\n");
  await writeFile(join(root, "ignored", "hidden.ts"), "const marker = 'hidden';\n");

  const listed = await invoke(tools, "ls", { path: ".", limit: 2 });
  assert.match(text(listed), /^\.git\/\n\.gitignore/);
  assert.match(text(listed), /2 entries limit reached/);

  const grepped = await invoke(tools, "grep", { pattern: "marker", limit: 1 });
  assert.match(text(grepped), /^src\/(?:second|visible)\.ts:1:/);
  assert.doesNotMatch(text(grepped), /hidden/);
  assert.match(text(grepped), /1 matches limit reached/);

  const found = await invoke(tools, "find", { pattern: "*.ts" });
  assert.match(text(found), /src\/visible\.ts/);
  assert.match(text(found), /src\/second\.ts/);
  assert.doesNotMatch(text(found), /hidden/);
});

test("grep limits the first semantic matches before pi capture truncation", async (t) => {
  const { root, tools } = await runtime(t);
  await writeFile(
    join(root, "many.txt"),
    Array.from({ length: 2_000 }, (_, index) => `marker-${String(index + 1).padStart(4, "0")}`).join("\n"),
  );

  const result = await invoke(tools, "grep", { pattern: "marker", limit: 2 });

  assert.match(text(result), /^many\.txt:1: marker-0001\nmany\.txt:2: marker-0002/);
  assert.doesNotMatch(text(result), /marker-2000/);
  assert.match(text(result), /2 matches limit reached/);
});

test("grep reports an oversized first match instead of a false empty result", async (t) => {
  const { root, tools } = await runtime(t);
  await writeFile(join(root, "wide.txt"), `marker-${"x".repeat(60_000)}\n`);

  const result = await invoke(tools, "grep", { pattern: "marker", limit: 1 });

  assert.doesNotMatch(text(result), /No matches found/);
  assert.match(text(result), /byte limit/i);
  assert.equal((result.details as { byteLimitReached?: boolean }).byteLimitReached, true);
});

test("grep displays the basename when searching one file", async (t) => {
  const { root, tools } = await runtime(t);
  await writeFile(join(root, "single.txt"), "marker\n");

  const result = await invoke(tools, "grep", {
    pattern: "marker",
    path: "single.txt",
  });

  assert.equal(text(result), "single.txt:1: marker");
});

test("find limits the first paths before pi capture truncation", async (t) => {
  const { root, tools } = await runtime(t);
  await mkdir(join(root, "files"));
  await writeFile(join(root, "files", "0000-first.ts"), "");
  await writeFile(join(root, "files", "0001-second.ts"), "");
  for (let index = 2; index < 1_200; index += 1) {
    await writeFile(
      join(root, "files", `${String(index).padStart(4, "0")}-${"x".repeat(48)}.ts`),
      "",
    );
  }

  const result = await invoke(tools, "find", {
    pattern: "*.ts",
    path: "files",
    limit: 2,
  });

  assert.match(text(result), /^0000-first\.ts\n0001-second\.ts/);
  assert.doesNotMatch(text(result), /1199-/);
  assert.match(text(result), /2 results limit reached/);
});

test("find applies the glob before its semantic record limit", async (t) => {
  const { root, tools } = await runtime(t);
  await mkdir(join(root, "mixed"));
  for (let index = 0; index < 20; index += 1) {
    await writeFile(join(root, "mixed", `${String(index).padStart(2, "0")}.txt`), "");
  }
  await writeFile(join(root, "mixed", "20-first.ts"), "");
  await writeFile(join(root, "mixed", "21-second.ts"), "");

  const result = await invoke(tools, "find", {
    pattern: "*.ts",
    path: "mixed",
    limit: 1,
  });

  assert.match(text(result), /^20-first\.ts/);
  assert.match(text(result), /1 results limit reached/);
});

test("ls marks symlinks to directories with a directory suffix", async (t) => {
  const { root, tools } = await runtime(t);
  await mkdir(join(root, "target"));
  await symlink(join(root, "target"), join(root, "alias"));

  const listed = await invoke(tools, "ls", {});

  assert.equal(text(listed), "alias/\ntarget/");
});

test("bash reports success, nonzero exits, timeout, and abort", async (t) => {
  const { tools } = await runtime(t);

  const success = await invoke(tools, "bash", { command: "printf success" });
  assert.equal(text(success), "success");
  assert.equal((success.details as { exitCode: number }).exitCode, 0);

  await assert.rejects(
    invoke(tools, "bash", { command: "printf failure >&2; exit 7" }),
    /failure[\s\S]*exited with code 7/,
  );
  await assert.rejects(
    invoke(tools, "bash", { command: "sleep 1", timeout: 0.01 }),
    /timed out after 0.01 seconds/,
  );

  const controller = new AbortController();
  const aborted = invoke(tools, "bash", { command: "sleep 10" }, controller.signal);
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(aborted, /aborted/i);
});

test("bash bounds large output with pi capture details", async (t) => {
  const { tools } = await runtime(t);

  const result = await invoke(tools, "bash", {
    command: "for i in {1..2105}; do echo line-$i; done",
  });

  assert.doesNotMatch(text(result), /^line-1\n/);
  assert.match(text(result), /line-2105\n?$/);
  assert.equal((result.details as { truncated: boolean }).truncated, true);
  assert.equal(typeof (result.details as { fullOutputPath: string }).fullOutputPath, "string");
});

test("schemas validate valid and invalid arguments with TypeBox Value", async (t) => {
  const { tools } = await runtime(t);
  const readSchema = tool(tools, "read").parameters;
  const writeSchema = tool(tools, "write").parameters;

  assert.equal(Value.Check(readSchema, { path: "notes.txt", offset: 1 }), true);
  assert.equal(Value.Check(readSchema, { path: "notes.txt", offset: 0 }), false);
  assert.equal(Value.Check(readSchema, { path: "notes.txt", extra: true }), false);
  assert.equal(Value.Check(writeSchema, { path: "notes.txt", content: "ok" }), true);
  assert.equal(Value.Check(writeSchema, { path: "notes.txt" }), false);
});
