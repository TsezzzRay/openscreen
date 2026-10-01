import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { Type, createModels, fauxProvider } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { PiAgentService } from "../../../src/agent/pi/service.js";

export function createRuntime(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "openscreen-pi-service-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const faux = fauxProvider({
    provider: `faux-${Math.random().toString(36).slice(2)}`,
    models: [{ id: "test-model", reasoning: true, input: ["text", "image"] }],
  });
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  const options = {
    cwd: root,
    sessionsRoot: join(root, "sessions"),
    models,
    model,
    systemPrompt: "Test system prompt",
  };

  return { root, faux, options };
}

export function findJsonlFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...findJsonlFiles(path));
    } else if (entry.name.endsWith(".jsonl")) {
      files.push(path);
    }
  }
  return files;
}

export function testTool(name: string): AgentTool {
  return {
    name,
    label: name,
    description: `${name} test tool`,
    parameters: Type.Object({}),
    async execute() {
      return { content: [{ type: "text", text: name }], details: {} };
    },
  };
}

export function sessionRuntimeProbe<T>(service: PiAgentService): T {
  return (service as unknown as { runtime: T }).runtime;
}
