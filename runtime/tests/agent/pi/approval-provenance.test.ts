import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, Type } from "@earendil-works/pi-ai";
import { PiAgentService } from "../../../src/agent/pi/service.js";
import { ToolSecurity } from "../../../src/security/tool-security.js";

test("conditional approval reporting names the user explicitly on every model request", async t => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-approval-provenance-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const faux = fauxProvider({ provider: "approval-provenance", models: [{ id: "test", input: ["text"] }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const prompts: string[] = [];
  faux.setResponses([
    context => {
      prompts.push(context.systemPrompt ?? "");
      return fauxAssistantMessage(fauxToolCall("read", {}), { stopReason: "toolUse" });
    },
    context => {
      prompts.push(context.systemPrompt ?? "");
      return fauxAssistantMessage("Observed file content.");
    },
  ]);
  const service = new PiAgentService({ cwd: root, sessionsRoot: join(root, "sessions"), models,
    model: faux.getModel(), toolSecurity: new ToolSecurity({ cwd: root, dataRoot: root }),
    tools: [{ name: "read", label: "read", description: "Read a fixture", parameters: Type.Object({}),
      async execute() { return { content: [{ type: "text" as const, text: "fixture" }], details: {} }; } }],
  });
  const sessionId = (await service.createSession()).session.id;
  await service.prompt(sessionId, { text: "Inspect the file" });
  assert.equal(prompts.length, 2);
  for (const prompt of prompts) {
    assert.match(prompt, /If your final answer mentions authorization.*explicitly.*user's one-time approval/);
    assert.match(prompt, /your one-time approval/);
    assert.match(prompt, /Apply the same conditional attribution rule to intermediate user-visible messages/);
    assert.doesNotMatch(prompt, /final answer must state/);
    assert.match(prompt, /Denial is final/);
    assert.match(prompt, /Do not claim a denied change succeeded/);
  }
});
