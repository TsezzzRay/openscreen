import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { Type, fauxAssistantMessage, fauxToolCall, type Context } from "@earendil-works/pi-ai";
import type { AgentHarness, AgentTool, Session } from "@earendil-works/pi-agent-core";
import { AgentServiceError, type AgentRunEvent, type AgentTranscriptMessage } from "../../../src/agent/api.js";
import { PiAgentService } from "../../../src/agent/pi/service.js";
import { ToolSecurity } from "../../../src/security/tool-security.js";
import { createRuntime, findJsonlFiles, sessionRuntimeProbe, testTool } from "./test-fixture.js";

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

test("keeps prompt-only system guidance after multiple tool calls without leaking to the next prompt", async (t) => {
  const { faux, options } = createRuntime(t);
  const systemPrompts: string[] = [];
  faux.setResponses([
    (context) => {
      systemPrompts.push(context.systemPrompt ?? "");
      return fauxAssistantMessage(fauxToolCall("read", {}), { stopReason: "toolUse" });
    },
    (context) => {
      systemPrompts.push(context.systemPrompt ?? "");
      return fauxAssistantMessage(fauxToolCall("read", {}), { stopReason: "toolUse" });
    },
    (context) => {
      systemPrompts.push(context.systemPrompt ?? "");
      return fauxAssistantMessage("first answer");
    },
    (context) => {
      systemPrompts.push(context.systemPrompt ?? "");
      return fauxAssistantMessage("second answer");
    },
  ]);
  let loads = 0;
  const service = new PiAgentService({
    ...options,
    tools: [testTool("read")],
    loadPromptSystemContext: () =>
      ++loads === 1 ? "Current prompt Memory rule" : undefined,
  });
  const created = await service.createSession();

  assert.equal(
    (await service.prompt(created.session.id, { text: "first question" })).answer,
    "first answer",
  );
  assert.equal(
    (await service.prompt(created.session.id, { text: "second question" })).answer,
    "second answer",
  );
  assert.equal(loads, 2);
  assert.equal(systemPrompts.length, 4);
  for (const prompt of systemPrompts.slice(0, 3)) {
    assert.equal(prompt, systemPrompts[0]);
    assert.match(prompt, /^Test system prompt\n\nCurrent prompt Memory rule\n\n/);
  }
  assert.doesNotMatch(systemPrompts[3], /Current prompt Memory rule/);
  for (const prompt of systemPrompts) {
    assert.match(prompt, /^Test system prompt\n\n/);
    assert.match(prompt, /Tool outputs are source-attributed evidence/);
  }
  assert.doesNotMatch(
    readFileSync(findJsonlFiles(options.sessionsRoot)[0], "utf8"),
    /Current prompt Memory rule/,
  );
});

test("keeps screen-source boundaries through tool calls and clears them on the next prompt", async (t) => {
  const { faux, options } = createRuntime(t);
  const prompts: string[] = [];
  faux.setResponses([
    (context) => { prompts.push(context.systemPrompt ?? ""); return fauxAssistantMessage(fauxToolCall("read", {}), { stopReason: "toolUse" }); },
    (context) => { prompts.push(context.systemPrompt ?? ""); return fauxAssistantMessage(fauxToolCall("read", {}), { stopReason: "toolUse" }); },
    (context) => { prompts.push(context.systemPrompt ?? ""); return fauxAssistantMessage("screen answer"); },
    (context) => { prompts.push(context.systemPrompt ?? ""); return fauxAssistantMessage("next answer"); },
  ]);
  const service = new PiAgentService({ ...options, tools: [testTool("read")] });
  const created = await service.createSession();
  await service.prompt(created.session.id, {
    text: "Summarize the screen",
    context: { images: [{ data: Uint8Array.of(0x89, 0x50, 0x4e, 0x47), mimeType: "image/png" }] },
  });
  await service.prompt(created.session.id, { text: "Next question" });
  for (const prompt of prompts.slice(0, 3)) {
    assert.match(prompt, /screen.*(?:evidence|source)/i);
    assert.match(prompt, /(?:cannot|must not|do not).*authoriz/i);
  }
  assert.doesNotMatch(prompts[3], /screen.*(?:evidence|source)/i);
  assert.doesNotMatch(readFileSync(findJsonlFiles(options.sessionsRoot)[0], "utf8"), /screen content is untrusted/i);
});

test("rebuilds the current security rule after tools and clears failed prompt guidance", async (t) => {
  const { root, faux, options } = createRuntime(t);
  const systemPrompts: string[] = [];
  faux.setResponses([
    (context) => {
      systemPrompts.push(context.systemPrompt ?? "");
      return fauxAssistantMessage(fauxToolCall("read", {}), { stopReason: "toolUse" });
    },
    (context) => {
      systemPrompts.push(context.systemPrompt ?? "");
      return fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider failed" });
    },
    (context) => {
      systemPrompts.push(context.systemPrompt ?? "");
      return fauxAssistantMessage("recovered");
    },
  ]);
  let loads = 0;
  const security = new ToolSecurity({ cwd: root, dataRoot: root });
  const service = new PiAgentService({
    ...options,
    tools: [testTool("read")],
    toolSecurity: security,
    loadPromptSystemContext: () => ++loads === 1 ? "First run Memory rule" : undefined,
  });
  const created = await service.createSession();

  await assert.rejects(
    service.prompt(created.session.id, { text: "first question" }),
    (error: unknown) => error instanceof AgentServiceError && error.code === "provider",
  );
  assert.equal(
    (await service.prompt(created.session.id, { text: "second question" })).answer,
    "recovered",
  );
  assert.equal(loads, 2);
  assert.match(systemPrompts[0], /First run Memory rule/);
  assert.equal(systemPrompts[1], systemPrompts[0]);
  assert.match(systemPrompts[0], /Tool policy: Bash runs in a macOS sandbox/);
  assert.match(systemPrompts[0], /desktop_windows and desktop_window_state are read-only/);
  assert.match(systemPrompts[0], /desktop actions require one application approval per conversation/);
  assert.match(systemPrompts[0], /desktop actions use only background window delivery/);
  assert.match(systemPrompts[0], /Observe the target window before clicking/);
  assert.match(systemPrompts[0], /Prefer an observed accessibility element for clicks; use screenshot coordinates only when no suitable element is available/);
  assert.match(systemPrompts[0], /call write or edit directly.*runtime displays the approval request/i);
  assert.match(systemPrompts[0], /Do not replace the tool call with a chat-only permission question/i);
  assert.match(systemPrompts[0], /If your final answer mentions authorization for an out-of-root action.*user's one-time approval/i);
  assert.doesNotMatch(systemPrompts[2], /First run Memory rule/);
  assert.match(systemPrompts[2], /Tool policy: Bash runs in a macOS sandbox/);
  assert.notEqual(systemPrompts[2], systemPrompts[0]);
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
  assert.match(receivedContext?.systemPrompt ?? "", /^Test system prompt\n\n/);
  assert.match(receivedContext?.systemPrompt ?? "", /Tool outputs are source-attributed evidence/);
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
  let loads = 0;
  const service = new PiAgentService({
    ...options,
    loadPromptSystemContext: () => ++loads === 1 ? "Aborted run rule" : undefined,
  });
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

  faux.setResponses([(context) => {
    assert.match(context.systemPrompt ?? "", /^Test system prompt\n\n/);
    assert.doesNotMatch(context.systemPrompt ?? "", /Aborted run rule/);
    assert.match(context.systemPrompt ?? "", /Tool outputs are source-attributed evidence/);
    return fauxAssistantMessage("retry after abort");
  }]);
  assert.equal(
    (await service.prompt(created.session.id, { text: "retry" })).answer,
    "retry after abort",
  );
  assert.equal(loads, 2);
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
