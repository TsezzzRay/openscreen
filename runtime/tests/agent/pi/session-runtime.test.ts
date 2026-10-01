import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import type { AgentHarness, Session } from "@earendil-works/pi-agent-core";
import { AgentServiceError } from "../../../src/agent/api.js";
import { PiAgentService } from "../../../src/agent/pi/service.js";
import { createRuntime, findJsonlFiles, sessionRuntimeProbe, testTool } from "./test-fixture.js";

test("uses the configured default model instead of persisted model changes", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "openscreen-pi-default-model-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const faux = fauxProvider({
    provider: `faux-${Math.random().toString(36).slice(2)}`,
    models: [{ id: "default-model" }, { id: "historical-model" }],
  });
  const models = createModels();
  models.setProvider(faux.provider);
  const options = {
    cwd: root,
    sessionsRoot: join(root, "sessions"),
    models,
    model: faux.getModel("default-model")!,
  };
  const original = new PiAgentService(options);
  const created = await original.createSession();
  const originalProbe = sessionRuntimeProbe<{
    entries: Map<string, Promise<{ session: Session }>>;
  }>(original);
  const originalEntry = await originalProbe.entries.get(created.session.id)!;
  await originalEntry.session.appendModelChange(
    faux.provider.id,
    "historical-model",
  );

  const reopenedService = new PiAgentService(options);
  const reopened = await reopenedService.getSession(created.session.id);
  const reopenedProbe = sessionRuntimeProbe<{
    entries: Map<string, Promise<{ harness: AgentHarness }>>;
  }>(reopenedService);
  const reopenedEntry = await reopenedProbe.entries.get(created.session.id)!;

  assert.equal("model" in reopened.state, false);
  assert.equal(reopenedEntry.harness.getModel().id, "default-model");
});

test("always enables every registered tool and ignores persisted tool selection", async (t) => {
  const { options } = createRuntime(t);
  const configured = {
    ...options,
    tools: [testTool("read"), testTool("write")],
  };
  const original = new PiAgentService(configured);
  const created = await original.createSession();
  const originalProbe = sessionRuntimeProbe<{
    entries: Map<string, Promise<{ session: Session }>>;
  }>(original);
  const originalEntry = await originalProbe.entries.get(created.session.id)!;
  await originalEntry.session.appendActiveToolsChange(["read"]);

  const reopenedService = new PiAgentService(configured);
  const reopened = await reopenedService.getSession(created.session.id);
  const reopenedProbe = sessionRuntimeProbe<{
    entries: Map<string, Promise<{ harness: AgentHarness }>>;
  }>(reopenedService);
  const reopenedEntry = await reopenedProbe.entries.get(created.session.id)!;

  assert.deepEqual(
    reopenedEntry.harness.getActiveTools().map((tool) => tool.name),
    ["read", "write"],
  );
  assert.deepEqual(reopened.state, { thinking: "off" });
});

test("keeps temporary system rules isolated across concurrent Sessions", async (t) => {
  const { options } = createRuntime(t);
  const service = new PiAgentService(options);
  const first = await service.createSession();
  const second = await service.createSession();
  const runtime = sessionRuntimeProbe<{
    entries: Map<string, Promise<{ harness: AgentHarness; session: Session }>>;
    withPromptSystemContext<T>(session: Session, context: string, operation: () => Promise<T>): Promise<T>;
  }>(service);
  const firstEntry = await runtime.entries.get(first.session.id)!;
  const secondEntry = await runtime.entries.get(second.session.id)!;
  const systemPromptOf = (harness: AgentHarness) =>
    (harness as unknown as {
      createTurnState(): Promise<{ systemPrompt: string }>;
    }).createTurnState().then((state) => state.systemPrompt);

  const [firstRule, secondRule] = await Promise.all([
    runtime.withPromptSystemContext(firstEntry.session, "Session A rule", () =>
      systemPromptOf(firstEntry.harness)),
    runtime.withPromptSystemContext(secondEntry.session, "Session B rule", () =>
      systemPromptOf(secondEntry.harness)),
  ]);

  assert.equal(firstRule, "Test system prompt\n\nSession A rule");
  assert.equal(secondRule, "Test system prompt\n\nSession B rule");
  assert.equal(await systemPromptOf(firstEntry.harness), "Test system prompt");
  assert.equal(await systemPromptOf(secondEntry.harness), "Test system prompt");
});

test("uses configured thinking until an explicit off change is persisted", async (t) => {
  const { options } = createRuntime(t);
  const serviceOptions = { ...options, thinking: "high" as const };
  const service = new PiAgentService(serviceOptions);
  const created = await service.createSession();

  assert.equal(created.state.thinking, "high");
  assert.equal(
    (await new PiAgentService(serviceOptions).getSession(created.session.id))
      .state.thinking,
    "high",
  );

  await service.setThinking(created.session.id, "off");
  assert.equal(
    (await new PiAgentService(serviceOptions).getSession(created.session.id))
      .state.thinking,
    "off",
  );
});

test("lists session metadata without caching harnesses", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "openscreen-pi-list-metadata-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const providerId = `faux-${Math.random().toString(36).slice(2)}`;
  const originalFaux = fauxProvider({
    provider: providerId,
    models: [{ id: "default-model" }, { id: "removed-model" }],
  });
  const originalModels = createModels();
  originalModels.setProvider(originalFaux.provider);
  const original = new PiAgentService({
    cwd: root,
    sessionsRoot: join(root, "sessions"),
    models: originalModels,
    model: originalFaux.getModel("default-model")!,
  });
  const healthy = await original.createSession();
  await original.renameSession(healthy.session.id, "Healthy session");
  const unavailable = await original.createSession();
  await original.renameSession(unavailable.session.id, "Unavailable session");
  const currentFaux = fauxProvider({
    provider: providerId,
    models: [{ id: "default-model" }],
  });
  const currentModels = createModels();
  currentModels.setProvider(currentFaux.provider);
  const service = new PiAgentService({
    cwd: root,
    sessionsRoot: join(root, "sessions"),
    models: currentModels,
    model: currentFaux.getModel("default-model")!,
  });
  const serviceProbe = sessionRuntimeProbe<{
    entries: Map<string, Promise<unknown>>;
    createHarness(session: Session): Promise<AgentHarness>;
  }>(service);
  let harnessCreations = 0;
  const originalCreateHarness = serviceProbe.createHarness.bind(serviceProbe);
  serviceProbe.createHarness = async (session) => {
    harnessCreations += 1;
    return originalCreateHarness(session);
  };

  const listed = await service.listSessions();

  assert.deepEqual(
    new Map(listed.map((summary) => [summary.id, summary.name])),
    new Map([
      [healthy.session.id, "Healthy session"],
      [unavailable.session.id, "Unavailable session"],
    ]),
  );
  assert.equal(harnessCreations, 0);
  assert.equal(serviceProbe.entries.size, 0);
});

test("lists healthy sessions while isolating malformed session bodies", async (t) => {
  const { options } = createRuntime(t);
  const original = new PiAgentService(options);
  const healthy = await original.createSession();
  await original.renameSession(healthy.session.id, "Healthy session");
  const corrupt = await original.createSession();
  const corruptPath = findJsonlFiles(options.sessionsRoot).find((path) =>
    readFileSync(path, "utf8").includes(`"id":"${corrupt.session.id}"`)
  );
  assert.ok(corruptPath);
  writeFileSync(
    corruptPath,
    `${readFileSync(corruptPath, "utf8")}not valid json\n`,
  );
  const service = new PiAgentService(options);
  const probe = sessionRuntimeProbe<{
    entries: Map<string, Promise<unknown>>;
  }>(service);

  const listed = await service.listSessions();

  assert.deepEqual(listed, [{
    id: healthy.session.id,
    createdAt: healthy.session.createdAt,
    name: "Healthy session",
  }]);
  assert.equal(probe.entries.size, 0);
});

test("concurrent lazy opens create only one harness for a session", async (t) => {
  const { options } = createRuntime(t);
  const creator = new PiAgentService(options);
  const created = await creator.createSession();
  const service = new PiAgentService(options);
  const probe = sessionRuntimeProbe<{
    createHarness(session: Session): Promise<AgentHarness>;
  }>(service);
  const originalCreateHarness = probe.createHarness.bind(probe);
  let creationCount = 0;
  let firstCreationStarted!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    firstCreationStarted = resolve;
  });
  let releaseFirstCreation!: () => void;
  const firstRelease = new Promise<void>((resolve) => {
    releaseFirstCreation = resolve;
  });
  probe.createHarness = async (session) => {
    creationCount += 1;
    if (creationCount === 1) {
      firstCreationStarted();
      await firstRelease;
    }
    return originalCreateHarness(session);
  };

  const first = service.getSession(created.session.id);
  await firstStarted;
  const second = service.getSession(created.session.id);
  await new Promise<void>((resolve) => setImmediate(resolve));
  releaseFirstCreation();
  await Promise.all([first, second]);

  assert.equal(creationCount, 1);
});

test("a failed lazy-open initialization is cleared for retry", async (t) => {
  const { options } = createRuntime(t);
  const creator = new PiAgentService(options);
  const created = await creator.createSession();
  const service = new PiAgentService(options);
  const probe = sessionRuntimeProbe<{
    createHarness(session: Session): Promise<AgentHarness>;
  }>(service);
  const originalCreateHarness = probe.createHarness.bind(probe);
  let creationCount = 0;
  probe.createHarness = async (session) => {
    creationCount += 1;
    if (creationCount === 1) {
      throw new Error("initialization failed");
    }
    return originalCreateHarness(session);
  };

  await assert.rejects(
    service.getSession(created.session.id),
    (error: unknown) =>
      error instanceof AgentServiceError && error.code === "unknown",
  );
  const retried = await service.getSession(created.session.id);

  assert.equal(retried.session.id, created.session.id);
  assert.equal(creationCount, 2);
});
