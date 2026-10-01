import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { SessionError, type Session } from "@earendil-works/pi-agent-core";
import { AgentServiceError, type AgentRunEvent, type AgentTranscriptMessage } from "../../../src/agent/api.js";
import { PiAgentService } from "../../../src/agent/pi/service.js";
import { createRuntime, findJsonlFiles, sessionRuntimeProbe } from "./test-fixture.js";

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
