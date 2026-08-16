import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  Type,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Context,
} from "@earendil-works/pi-ai";
import {
  FileError,
  SessionError,
  type AgentHarness,
  type AgentTool,
  type Session,
} from "@earendil-works/pi-agent-core";
import {
  AgentServiceError,
  type AgentRunEvent,
  type AgentTranscriptMessage,
} from "../../src/agent/api.js";
import { PiAgentService } from "../../src/agent/pi/service.js";

function createRuntime(t: TestContext) {
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

function findJsonlFiles(root: string): string[] {
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

function textOfContext(context: Context): string[] {
  return context.messages.map((message) => {
    if (message.role === "assistant") {
      return message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
    }
    if (typeof message.content === "string") {
      return message.content;
    }
    return message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");
  });
}

function testTool(name: string): AgentTool {
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

function sessionRuntimeProbe<T>(service: PiAgentService): T {
  return (service as unknown as { runtime: T }).runtime;
}

test("streams an answer and reopens its persisted JSONL session", async (t) => {
  const { faux, options } = createRuntime(t);
  faux.setResponses([fauxAssistantMessage("persisted answer")]);
  const service = new PiAgentService(options);
  const created = await service.createSession();
  const events: AgentRunEvent[] = [];

  const result = await service.prompt(
    created.session.id,
    { text: "hello" },
    (event: AgentRunEvent) => {
      events.push(event);
    },
  );

  assert.equal(result.answer, "persisted answer");
  assert.equal(events[0]?.type, "run-start");
  assert.equal(
    events
      .filter((event) => event.type === "answer-delta")
      .map((event) => event.delta)
      .join(""),
    "persisted answer",
  );
  assert.deepEqual(events.at(-1), {
    type: "complete",
    answer: "persisted answer",
  });

  const files = findJsonlFiles(options.sessionsRoot);
  assert.equal(files.length, 1);
  assert.match(readFileSync(files[0], "utf8"), /"type":"session"/);

  const reopened = await new PiAgentService(options).getSession(
    created.session.id,
  );
  assert.deepEqual(
    reopened.messages.map((message: AgentTranscriptMessage) => [
      message.role,
      message.text,
    ]),
    [
      ["user", "hello"],
      ["assistant", "persisted answer"],
    ],
  );
});

test("notifies Turn Memory asynchronously only after a successful prompt", async (t) => {
  const { faux, options } = createRuntime(t);
  faux.setResponses([fauxAssistantMessage("persisted answer")]);
  let notifiedSessionId: string | undefined;
  let releaseNotification!: () => void;
  const notificationPending = new Promise<void>((resolve) => {
    releaseNotification = resolve;
  });
  const service = new PiAgentService({
    ...options,
    onPromptSettled: async (sessionId) => {
      notifiedSessionId = sessionId;
      await notificationPending;
    },
  });
  const created = await service.createSession();

  const result = await service.prompt(created.session.id, { text: "hello" });
  assert.equal(result.answer, "persisted answer");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(notifiedSessionId, created.session.id);
  releaseNotification();

  faux.setResponses([
    fauxAssistantMessage("", {
      stopReason: "error",
      errorMessage: "provider failed",
    }),
  ]);
  let failureNotifications = 0;
  const failing = new PiAgentService({
    ...options,
    onPromptSettled: () => {
      failureNotifications += 1;
      throw new Error("notification failure must be isolated");
    },
  });
  await assert.rejects(
    failing.prompt(created.session.id, { text: "fail" }),
    (error: unknown) =>
      error instanceof AgentServiceError && error.code === "provider",
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(failureNotifications, 0);
});

test("reports final context usage with the model context window", async (t) => {
  const { options } = createRuntime(t);
  const response = fauxAssistantMessage("usage-aware answer");
  response.usage = {
    input: 1_200,
    output: 300,
    cacheRead: 100,
    cacheWrite: 50,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  response.api = options.model.api;
  response.provider = options.model.provider;
  response.model = options.model.id;
  const service = new PiAgentService(options);
  const created = await service.createSession();
  const serviceProbe = sessionRuntimeProbe<{
    entries: Map<string, Promise<{ harness: AgentHarness; session: Session }>>;
  }>(service);
  const entry = await serviceProbe.entries.get(created.session.id)!;
  const harnessProbe = entry.harness as unknown as {
    prompt(): Promise<typeof response>;
  };
  harnessProbe.prompt = async () => response;

  const result = await service.prompt(created.session.id, { text: "usage" });

  assert.deepEqual(result.contextUsage, {
    contextTokens: 1_650,
    contextWindow: options.model.contextWindow,
  });
});

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

test("compactIfNeeded delegates only when pi compaction policy says so", async (t) => {
  const { options } = createRuntime(t);
  let usage = {
    input: options.model.contextWindow,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: options.model.contextWindow + 1,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const service = new PiAgentService(options);
  const created = await service.createSession();
  const serviceProbe = sessionRuntimeProbe<{
    entries: Map<string, Promise<{ harness: AgentHarness; session: Session }>>;
  }>(service);
  const entry = await serviceProbe.entries.get(created.session.id)!;
  const sessionProbe = entry.session as unknown as {
    getBranch(): Promise<unknown[]>;
    getEntries(): Promise<unknown[]>;
  };
  sessionProbe.getEntries = async () => {
    throw new Error("inactive branches must not drive compaction");
  };
  sessionProbe.getBranch = async () => [
    {
      type: "message",
      id: "assistant-entry",
      parentId: null,
      timestamp: "2026-08-13T00:00:00.000Z",
      message: {
        ...fauxAssistantMessage("large-context answer"),
        usage,
      },
    },
  ];
  let compactionCalls = 0;
  const harnessProbe = entry.harness as unknown as {
    compact(): Promise<{
      summary: string;
      firstKeptEntryId: string;
      tokensBefore: number;
    }>;
  };
  harnessProbe.compact = async () => {
    compactionCalls += 1;
    return {
      summary: "automatic summary",
      firstKeptEntryId: "kept-entry",
      tokensBefore: usage.totalTokens,
    };
  };

  const compacted = await service.compactIfNeeded(created.session.id);

  assert.deepEqual(compacted, {
    summary: "automatic summary",
    firstKeptEntryId: "kept-entry",
    tokensBefore: usage.totalTokens,
  });
  assert.equal(compactionCalls, 1);

  usage = {
    ...usage,
    input: 1,
    output: 1,
    totalTokens: 2,
  };
  assert.equal(await service.compactIfNeeded(created.session.id), undefined);
  assert.equal(compactionCalls, 1);
});

test("injects and persists generic context without exposing it in the transcript", async (t) => {
  const { root, faux, options } = createRuntime(t);
  const imagePath = join(root, "context.png");
  writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  let receivedContext: Context | undefined;
  faux.setResponses([
    (context) => {
      receivedContext = context;
      return fauxAssistantMessage("context received");
    },
  ]);
  const service = new PiAgentService(options);
  const created = await service.createSession();

  await service.prompt(created.session.id, {
    text: "use the context",
    context: {
      text: "private generic context",
      images: [{ path: imagePath, mimeType: "image/png" }],
    },
  });

  assert.ok(receivedContext);
  assert.deepEqual(textOfContext(receivedContext), [
    "use the context",
    "private generic context",
  ]);
  const contextMessage = receivedContext.messages[1];
  assert.equal(contextMessage.role, "user");
  assert.notEqual(typeof contextMessage.content, "string");
  if (contextMessage.role !== "user" || typeof contextMessage.content === "string") {
    assert.fail("expected injected user context blocks");
  }
  assert.deepEqual(contextMessage.content[1], {
    type: "image",
    data: "iVBORw==",
    mimeType: "image/png",
  });

  const view = await service.getSession(created.session.id);
  assert.deepEqual(
    view.messages.map((message: AgentTranscriptMessage) => message.text),
    ["use the context", "context received"],
  );
  const jsonl = readFileSync(findJsonlFiles(options.sessionsRoot)[0], "utf8");
  const entries = jsonl
    .trim()
    .split("\n")
    .slice(1)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const hiddenContext = entries.filter(
    (entry) =>
      entry.type === "message" &&
      (entry.message as Record<string, unknown> | undefined)?.role === "custom" &&
      (entry.message as Record<string, unknown> | undefined)?.customType ===
        "openscreen.injected-context",
  );
  assert.equal(hiddenContext.length, 1);
  assert.equal(
    (hiddenContext[0].message as Record<string, unknown>).display,
    false,
  );
});

test("injects in-memory context images without reading a path", async (t) => {
  const { faux, options } = createRuntime(t);
  let receivedContext: Context | undefined;
  faux.setResponses([
    (context) => {
      receivedContext = context;
      return fauxAssistantMessage("data context received");
    },
  ]);
  const service = new PiAgentService(options);
  const created = await service.createSession();
  const probe = sessionRuntimeProbe<{
    env: {
      readBinaryFile(path: string): Promise<{
        ok: true;
        value: Uint8Array;
      } | {
        ok: false;
        error: Error;
      }>;
    };
  }>(service);
  let readCount = 0;
  probe.env.readBinaryFile = async () => {
    readCount += 1;
    throw new Error("data images must not read a path");
  };

  await service.prompt(created.session.id, {
    text: "use data context",
    context: {
      text: "private data context",
      images: [{ data: Uint8Array.of(0x89, 0x50, 0x4e, 0x47), mimeType: "image/jpeg" }],
    },
  });

  assert.equal(readCount, 0);
  assert.ok(receivedContext);
  const contextMessage = receivedContext?.messages[1];
  if (contextMessage?.role !== "user" || typeof contextMessage.content === "string") {
    assert.fail("expected injected user context blocks");
  }
  assert.deepEqual(contextMessage.content[1], {
    type: "image",
    data: "iVBORw==",
    mimeType: "image/jpeg",
  });
});

test("injects optional Memory guidance through the per-Turn system prompt only", async (t) => {
  const { faux, options } = createRuntime(t);
  let receivedContext: Context | undefined;
  let loads = 0;
  faux.setResponses([(context) => {
    receivedContext = context;
    return fauxAssistantMessage("memory-aware answer");
  }]);
  const service = new PiAgentService({
    ...options,
    loadPromptSystemContext: async () => {
      loads += 1;
      return "OpenScreen Memory read policy: search MEMORY.md with grep.";
    },
  });
  const created = await service.createSession();

  await service.prompt(created.session.id, { text: "What did we decide?" });

  assert.equal(loads, 1);
  assert.ok(receivedContext);
  assert.match(receivedContext.systemPrompt ?? "", /Test system prompt/);
  assert.match(receivedContext.systemPrompt ?? "", /search MEMORY\.md with grep/);
  assert.deepEqual(textOfContext(receivedContext), ["What did we decide?"]);
  const jsonl = readFileSync(findJsonlFiles(options.sessionsRoot)[0], "utf8");
  assert.doesNotMatch(jsonl, /OpenScreen Memory read policy/);
});

test("continues without Memory context when its optional loader fails", async (t) => {
  const { faux, options } = createRuntime(t);
  let receivedContext: Context | undefined;
  faux.setResponses([(context) => {
    receivedContext = context;
    return fauxAssistantMessage("plain answer");
  }]);
  const service = new PiAgentService({
    ...options,
    loadPromptSystemContext: async () => {
      throw new Error("Memory unavailable");
    },
  });
  const created = await service.createSession();

  assert.equal(
    (await service.prompt(created.session.id, { text: "hello" })).answer,
    "plain answer",
  );
  assert.equal(receivedContext?.systemPrompt, "Test system prompt");
});

test("strips and persists a validated Memory citation after an actual file read", async (t) => {
  const { root, faux, options } = createRuntime(t);
  const memoryRoot = join(root, "memory");
  const memoryPath = join(memoryRoot, "MEMORY.md");
  mkdirSync(memoryRoot);
  writeFileSync(memoryPath, "# OpenScreen Memory\n");
  const readParameters = Type.Object({
    path: Type.String(),
    offset: Type.Optional(Type.Integer()),
    limit: Type.Optional(Type.Integer()),
  });
  const readTool: AgentTool<typeof readParameters> = {
    name: "read",
    label: "Read",
    description: "Read a test file",
    parameters: readParameters,
    async execute(_id, args) {
      return {
        content: [{ type: "text", text: readFileSync(args.path, "utf8") }],
        details: { path: args.path, offset: 1, linesReturned: 1 },
      };
    },
  };
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("read", { path: memoryPath, offset: 1, limit: 1 }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage([
      {
        type: "text",
        text: "The project has Memory enabled.\n<oai-mem-citation>{\"entries\":[{\"path\":\"MEMORY.md\",\"lineStart\":1,\"lineEnd\":1,\"note\":\"Memory registry heading\"}],\"rolloutIds\":[]}</oai-mem-citation>",
      },
    ]),
  ]);
  const service = new PiAgentService({
    ...options,
    tools: [readTool],
    memoryCitationRoot: memoryRoot,
  });
  const created = await service.createSession();
  const events: AgentRunEvent[] = [];

  const result = await service.prompt(
    created.session.id,
    { text: "What does Memory say?" },
    (event) => {
      events.push(event);
    },
  );

  assert.equal(result.answer, "The project has Memory enabled.");
  assert.doesNotMatch(
    events
      .filter((event) => event.type === "answer-delta")
      .map((event) => event.delta)
      .join(""),
    /oai-mem-citation/,
  );
  assert.equal(
    (await service.getSession(created.session.id)).messages.at(-1)?.text,
    "The project has Memory enabled.",
  );
  const entries = readFileSync(findJsonlFiles(options.sessionsRoot)[0], "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const citation = entries.find((entry) =>
    entry.type === "custom" && entry.customType === "openscreen.memory-citation"
  );
  assert.ok(citation);
  assert.deepEqual(
    (citation.data as { entries: unknown[] }).entries.length,
    1,
  );
});

test("a concurrent busy prompt cannot inject its context into the active run", async (t) => {
  const { faux, options } = createRuntime(t);
  let receivedContext: Context | undefined;
  faux.setResponses([
    (context) => {
      receivedContext = context;
      return fauxAssistantMessage("answer A");
    },
  ]);
  const service = new PiAgentService(options);
  const created = await service.createSession();
  const serviceProbe = sessionRuntimeProbe<{
    entries: Map<string, Promise<{ harness: AgentHarness }>>;
  }>(service);
  const entry = await serviceProbe.entries.get(created.session.id)!;
  const harnessProbe = entry.harness as unknown as {
    createTurnState(): Promise<unknown>;
  };
  const originalCreateTurnState = harnessProbe.createTurnState.bind(
    entry.harness,
  );
  let activeTurnPaused!: () => void;
  const activePaused = new Promise<void>((resolve) => {
    activeTurnPaused = resolve;
  });
  let resumeActiveTurn!: () => void;
  const activeRelease = new Promise<void>((resolve) => {
    resumeActiveTurn = resolve;
  });
  let shouldPause = true;
  harnessProbe.createTurnState = async () => {
    const state = await originalCreateTurnState();
    if (shouldPause) {
      shouldPause = false;
      activeTurnPaused();
      await activeRelease;
    }
    return state;
  };

  const promptA = service.prompt(created.session.id, {
    text: "prompt A",
    context: { text: "context A" },
  });
  await activePaused;

  let busyNotificationStarted!: () => void;
  const busyNotification = new Promise<void>((resolve) => {
    busyNotificationStarted = resolve;
  });
  let finishBusyNotification!: () => void;
  const busyNotificationRelease = new Promise<void>((resolve) => {
    finishBusyNotification = resolve;
  });
  const promptB = service.prompt(
    created.session.id,
    { text: "prompt B", context: { text: "context B" } },
    async (event) => {
      if (event.type === "failure") {
        busyNotificationStarted();
        await busyNotificationRelease;
      }
    },
  );
  let promptBError: unknown;
  let promptBResolved = false;
  const promptBSettled = promptB.then(
    () => {
      promptBResolved = true;
    },
    (error: unknown) => {
      promptBError = error;
    },
  );
  await Promise.race([busyNotification, promptBSettled]);

  try {
    resumeActiveTurn();
    const resultA = await promptA;
    assert.equal(resultA.answer, "answer A");
  } finally {
    finishBusyNotification();
  }
  await promptBSettled;
  assert.equal(promptBResolved, false);
  assert.ok(
    promptBError instanceof AgentServiceError && promptBError.code === "busy",
  );
  assert.ok(receivedContext);
  assert.deepEqual(textOfContext(receivedContext), ["prompt A", "context A"]);
});

test("abort during local image preparation prevents the provider run", async (t) => {
  const { root, faux, options } = createRuntime(t);
  const imagePath = join(root, "delayed.png");
  writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  faux.setResponses([fauxAssistantMessage("must not run")]);
  const service = new PiAgentService(options);
  const created = await service.createSession();
  const serviceProbe = sessionRuntimeProbe<{
    env: {
      readBinaryFile(path: string): Promise<{
        ok: true;
        value: Uint8Array;
      } | {
        ok: false;
        error: Error;
      }>;
    };
  }>(service);
  const originalRead = serviceProbe.env.readBinaryFile.bind(serviceProbe.env);
  let imageReadStarted!: () => void;
  const imageReading = new Promise<void>((resolve) => {
    imageReadStarted = resolve;
  });
  let releaseImageRead!: () => void;
  const imageReadRelease = new Promise<void>((resolve) => {
    releaseImageRead = resolve;
  });
  serviceProbe.env.readBinaryFile = async (path) => {
    imageReadStarted();
    await imageReadRelease;
    return originalRead(path);
  };

  const prompt = service.prompt(created.session.id, {
    text: "do not start",
    context: {
      text: "hidden context",
      images: [{ path: imagePath, mimeType: "image/png" }],
    },
  });
  await imageReading;
  await service.abort(created.session.id);
  releaseImageRead();

  await assert.rejects(
    prompt,
    (error: unknown) =>
      error instanceof AgentServiceError && error.code === "aborted",
  );
  assert.equal(faux.state.callCount, 0);

  serviceProbe.env.readBinaryFile = originalRead;
  faux.setResponses([fauxAssistantMessage("retry works")]);
  const retried = await service.prompt(created.session.id, {
    text: "retry",
  });
  assert.equal(retried.answer, "retry works");
});

test("abort after turn-state creation prevents the provider run", async (t) => {
  const { faux, options } = createRuntime(t);
  faux.setResponses([fauxAssistantMessage("must not run")]);
  const service = new PiAgentService(options);
  const created = await service.createSession();
  const probe = sessionRuntimeProbe<{
    entries: Map<string, Promise<{ harness: AgentHarness }>>;
  }>(service);
  const entry = await probe.entries.get(created.session.id)!;
  const harnessProbe = entry.harness as unknown as {
    createTurnState(): Promise<unknown>;
  };
  const originalCreateTurnState = harnessProbe.createTurnState.bind(entry.harness);
  let turnStateCreated!: () => void;
  const turnStateReady = new Promise<void>((resolve) => {
    turnStateCreated = resolve;
  });
  let releaseTurnState!: () => void;
  const turnStateRelease = new Promise<void>((resolve) => {
    releaseTurnState = resolve;
  });
  harnessProbe.createTurnState = async () => {
    const state = await originalCreateTurnState();
    turnStateCreated();
    await turnStateRelease;
    return state;
  };

  const prompt = service.prompt(created.session.id, { text: "do not call provider" });
  const promptRejected = assert.rejects(
    prompt,
    (error: unknown) =>
      error instanceof AgentServiceError && error.code === "aborted",
  );
  await turnStateReady;
  let abortCompleted = false;
  const abort = service.abort(created.session.id).then(() => {
    abortCompleted = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(abortCompleted, false);

  releaseTurnState();
  await Promise.all([promptRejected, abort]);

  assert.equal(abortCompleted, true);
  assert.equal(faux.state.callCount, 0);
});

test("abort between agent-start hooks and the provider request skips the provider", async (t) => {
  const { faux, options } = createRuntime(t);
  faux.setResponses([fauxAssistantMessage("must not run")]);
  const service = new PiAgentService(options);
  const created = await service.createSession();
  const probe = sessionRuntimeProbe<{
    entries: Map<string, Promise<{ harness: AgentHarness }>>;
  }>(service);
  const entry = await probe.entries.get(created.session.id)!;
  const harnessProbe = entry.harness as unknown as {
    handlers: Map<string, Set<unknown>>;
  };
  const prompt = service.prompt(created.session.id, {
    text: "abort before provider",
  });
  let microtaskDepth = 0;
  while (
    (harnessProbe.handlers.get("before_agent_start")?.size ?? 0) === 0 &&
    microtaskDepth < 20
  ) {
    microtaskDepth += 1;
    await Promise.resolve();
  }
  assert.ok(microtaskDepth > 0 && microtaskDepth < 20);

  let agentStartObserved!: () => void;
  const agentStart = new Promise<void>((resolve) => {
    agentStartObserved = resolve;
  });
  let releaseAgentStart!: () => void;
  const agentStartRelease = new Promise<void>((resolve) => {
    releaseAgentStart = resolve;
  });
  const removeAgentStartObserver = entry.harness.on(
    "before_agent_start",
    async () => {
      agentStartObserved();
      await agentStartRelease;
      return undefined;
    },
  );
  let providerObserverCalls = 0;
  const removeProviderObserver = entry.harness.on(
    "before_provider_request",
    () => {
      providerObserverCalls += 1;
      return undefined;
    },
  );

  await agentStart;
  const abort = service.abort(created.session.id);
  releaseAgentStart();

  await assert.rejects(
    prompt,
    (error: unknown) =>
      error instanceof AgentServiceError && error.code === "aborted",
  );
  await abort;
  assert.equal(providerObserverCalls, 0);
  assert.equal(faux.state.callCount, 0);
  removeAgentStartObserver();
  removeProviderObserver();
});

test("prompt guard releases after image loading and run failures", async (t) => {
  const { root, faux, options } = createRuntime(t);
  const service = new PiAgentService(options);
  const created = await service.createSession();

  await assert.rejects(
    service.prompt(created.session.id, {
      text: "missing image",
      images: [{ path: join(root, "missing.png"), mimeType: "image/png" }],
    }),
    (error: unknown) =>
      error instanceof AgentServiceError && error.code === "invalid-argument",
  );

  faux.setResponses([
    fauxAssistantMessage("", {
      stopReason: "error",
      errorMessage: "run failed",
    }),
  ]);
  await assert.rejects(
    service.prompt(created.session.id, { text: "provider failure" }),
    (error: unknown) =>
      error instanceof AgentServiceError && error.code === "provider",
  );

  faux.setResponses([fauxAssistantMessage("guard released")]);
  const result = await service.prompt(created.session.id, {
    text: "retry after failures",
  });
  assert.equal(result.answer, "guard released");
});

test("renames, lists, views, and delegates thinking state to the harness", async (t) => {
  const { options } = createRuntime(t);
  const service = new PiAgentService(options);
  const created = await service.createSession();

  const renamed = await service.renameSession(created.session.id, "Research thread");
  const state = await service.setThinking(created.session.id, "high");

  assert.equal(renamed.name, "Research thread");
  assert.equal(state.thinking, "high");
  assert.equal((await service.listSessions())[0]?.name, "Research thread");
  const view = await service.getSession(created.session.id);
  assert.equal(view.session.name, "Research thread");
  assert.equal(view.state.thinking, "high");
});

test("uses the first user question as the title until explicitly renamed", async (t) => {
  const { faux, options } = createRuntime(t);
  faux.setResponses([fauxAssistantMessage("answer")]);
  const service = new PiAgentService(options);
  const created = await service.createSession();

  await service.prompt(created.session.id, {
    text: "  First   question\nabout the screen  ",
  });

  const reopened = new PiAgentService(options);
  assert.equal(
    (await reopened.getSession(created.session.id)).session.name,
    "First question about the screen",
  );
  assert.equal(
    (await reopened.listSessions()).find(
      (session) => session.id === created.session.id,
    )?.name,
    "First question about the screen",
  );

  await reopened.renameSession(created.session.id, "Pinned title");
  assert.equal(
    (await reopened.getSession(created.session.id)).session.name,
    "Pinned title",
  );
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

test("normalizes non-isolated list failures at the public boundary", async (t) => {
  const { options } = createRuntime(t);
  const service = new PiAgentService(options);
  const probe = sessionRuntimeProbe<{
    repo: {
      list(options: { cwd: string }): Promise<Array<{
        id: string;
        createdAt: string;
      }>>;
      open(metadata: unknown): Promise<Session>;
    };
  }>(service);
  probe.repo.list = async () => [{
    id: "unreadable-session",
    createdAt: "2026-08-13T00:00:00.000Z",
  }];
  probe.repo.open = async () => {
    throw new SessionError("storage", "session body unavailable");
  };

  await assert.rejects(
    service.listSessions(),
    (error: unknown) =>
      error instanceof AgentServiceError &&
      error.code === "session" &&
      error.message === "session body unavailable",
  );
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

test("normalizes pi session errors from lazy open", async (t) => {
  const mappings = [
    ["not_found", "not-found"],
    ["invalid_entry", "invalid-argument"],
    ["invalid_fork_target", "invalid-argument"],
    ["storage", "session"],
  ] as const;

  for (const [piCode, neutralCode] of mappings) {
    const { options } = createRuntime(t);
    const service = new PiAgentService(options);
    const probe = sessionRuntimeProbe<{
      repo: { list(): Promise<never> };
    }>(service);
    probe.repo.list = async () => {
      throw new SessionError(piCode, `pi ${piCode}`);
    };

    await assert.rejects(service.getSession("session-id"), (error: unknown) => {
      assert.equal(error instanceof SessionError, false);
      return (
        error instanceof AgentServiceError && error.code === neutralCode
      );
    });
  }
});

test("listener failures cannot fail a successful persisted run", async (t) => {
  const { faux, options } = createRuntime(t);
  faux.setResponses([fauxAssistantMessage("listener-safe answer")]);
  const service = new PiAgentService(options);
  const created = await service.createSession();

  const result = await service.prompt(
    created.session.id,
    { text: "listener prompt" },
    () => {
      throw new Error("listener failed");
    },
  );

  assert.equal(result.answer, "listener-safe answer");
  const reopened = await new PiAgentService(options).getSession(
    created.session.id,
  );
  assert.deepEqual(
    reopened.messages.map((message) => message.text),
    ["listener prompt", "listener-safe answer"],
  );
});

test("listener failures cannot replace a provider failure", async (t) => {
  const { faux, options } = createRuntime(t);
  faux.setResponses([
    fauxAssistantMessage("", {
      stopReason: "error",
      errorMessage: "provider unavailable",
    }),
  ]);
  const service = new PiAgentService(options);
  const created = await service.createSession();

  await assert.rejects(
    service.prompt(created.session.id, { text: "fail" }, () => {
      throw new Error("listener failed");
    }),
    (error: unknown) =>
      error instanceof AgentServiceError &&
      error.code === "provider" &&
      error.message === "provider unavailable",
  );
});
