import assert from "node:assert/strict";
import test from "node:test";

import type { AgentTool } from "../../src/types.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { createSystemToolRegistry } from "../../src/tools/system/index.js";

function tool(
  name: string,
  description = `${name} description`,
  guidelines: string[] = [],
): AgentTool {
  return {
    definition: {
      type: "function",
      name,
      description,
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      strict: true,
    },
    source: "system",
    guidelines,
    execute: async () => `${name} result`,
  };
}

test("exposes only one immutable runtime snapshot", () => {
  const read = tool("read");
  const bash = tool("bash");
  const registry = new ToolRegistry([read, bash]);
  const snapshot = registry.getSnapshot();

  assert.deepEqual(
    Object.getOwnPropertyNames(ToolRegistry.prototype).sort(),
    ["constructor", "getSnapshot"].sort(),
  );
  assert.equal(registry.getSnapshot(), snapshot);
  assert.deepEqual(snapshot.tools, [read, bash]);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.tools), true);
  assert.equal(Object.isFrozen(snapshot.tools[0]), true);
  assert.notEqual(snapshot.tools[0].definition, read.definition);
  assert.deepEqual(snapshot.tools[0].definition, read.definition);
  assert.equal(Object.isFrozen(snapshot.tools[0].definition), true);
  assert.equal(Object.isFrozen(snapshot.tools[0].definition.parameters), true);
  if (false) {
    // @ts-expect-error Registry snapshot tools are immutable.
    snapshot.tools[0].source = "extension";
    // @ts-expect-error Registry snapshot definitions are immutable.
    snapshot.tools[0].definition.description = "changed";
    // @ts-expect-error Registry snapshot parameters are deeply immutable.
    snapshot.tools[0].definition.parameters!["type"] = "object";
  }
});

test("isolates immutable definitions from mutations to caller-owned tools", () => {
  const read = tool("read", "original description");
  const registry = new ToolRegistry([read]);
  const snapshot = registry.getSnapshot();
  (read.definition as any).description = "mutated description";
  (read.definition.parameters as any).properties.extra = { type: "string" };

  assert.equal(snapshot.tools[0].definition.description, "original description");
  assert.equal(
    "extra" in ((snapshot.tools[0].definition.parameters as any).properties),
    false,
  );
  assert.match(snapshot.capabilityPrompt, /original description/);
  assert.doesNotMatch(snapshot.capabilityPrompt, /mutated description/);
});

test("rejects duplicate definitions and unknown initial active names", () => {
  assert.throws(
    () => new ToolRegistry([tool("read"), tool("read")]),
    /Duplicate tool name: read/,
  );
  assert.throws(
    () => new ToolRegistry([tool("read")], ["missing"]),
    /Unknown tool name: missing/,
  );
  assert.throws(
    () => new ToolRegistry([tool("read")], ["read", "read"]),
    /Duplicate active tool name: read/,
  );
});

test("builds one initial active snapshot and capability prompt", () => {
  const registry = new ToolRegistry([
    tool("read", "Read a UTF-8 text file", ["Use offset to continue truncated output."]),
    tool("bash", "Run a shell command", ["Inspect the exit code before claiming success."]),
  ], ["bash"]);

  const snapshot = registry.getSnapshot();
  assert.deepEqual(snapshot.tools.map(({ definition }) => definition.name), ["bash"]);
  assert.doesNotMatch(snapshot.capabilityPrompt, /read:/);
  assert.match(snapshot.capabilityPrompt, /bash: Run a shell command/);
  assert.match(snapshot.capabilityPrompt, /Inspect the exit code before claiming success\./);
});

test("activates all seven system tools with no sequential execution setting", () => {
  const registry = createSystemToolRegistry({
    cwd: "/workspace",
    outputDirectory: "/data/tool-output",
  });

  const snapshot = registry.getSnapshot();
  assert.deepEqual(snapshot.tools.map(({ definition }) => definition.name), [
    "read", "ls", "grep", "find", "write", "edit", "bash",
  ]);
  for (const tool of snapshot.tools) {
    assert.equal("executionMode" in tool, false);
    assert.equal("sequential" in tool, false);
    if (tool.definition.strict) {
      const parameters = tool.definition.parameters as any;
      assert.deepEqual(
        [...(parameters.required ?? [])].sort(),
        Object.keys(parameters.properties ?? {}).sort(),
        `${tool.definition.name} uses strict mode with optional schema fields`,
      );
    }
  }
});
