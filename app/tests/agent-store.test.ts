import { describe, expect, test, vi } from "vitest";

import type { ActiveRun, AgentStatus } from "@shared/ipc.ts";
import type {
  ApplicationCommand,
  ApplicationEvent,
  ProductSessionView,
} from "@shared/protocol.ts";

import { AgentStore } from "@/store/agent-store.ts";
import { AgentFailureError, type AgentGateway } from "@/store/transport.ts";

const at = "2026-08-21T00:00:00.000Z";

function view(id: string, messages: ProductSessionView["messages"] = []): ProductSessionView {
  return {
    session: { id, createdAt: at, name: `chat ${id}` },
    messages,
    state: { thinking: "medium" },
  };
}

/**
 * A gateway whose prompt runs are driven by the test: `send` parks the run and
 * hands back the event sink, so a streaming turn can be inspected mid-flight.
 */
class StubGateway implements AgentGateway {
  readonly commands: ApplicationCommand[] = [];
  views = new Map<string, ProductSessionView>();
  sessions: ProductSessionView["session"][] = [];
  run:
    | {
        emit: (event: ApplicationEvent) => void;
        finish: () => void;
        fail: (error: Error) => void;
      }
    | undefined;

  private readonly runListeners = new Set<(runs: ActiveRun[]) => void>();
  private readonly invalidationListeners = new Set<() => void>();
  private readonly unclaimedListeners = new Set<
    (requestId: string, event: ApplicationEvent) => void
  >();

  onStatus(_listener: (status: AgentStatus) => void): () => void {
    return () => {};
  }

  onActiveRuns(listener: (runs: ActiveRun[]) => void): () => void {
    this.runListeners.add(listener);
    return () => this.runListeners.delete(listener);
  }

  onSessionsInvalidated(listener: () => void): () => void {
    this.invalidationListeners.add(listener);
    return () => this.invalidationListeners.delete(listener);
  }

  /** Stands in for the main process reporting a changed chat list. */
  emitSessionsInvalidated(): void {
    for (const listener of this.invalidationListeners) listener();
  }

  onUnclaimedEvent(
    listener: (requestId: string, event: ApplicationEvent) => void,
  ): () => void {
    this.unclaimedListeners.add(listener);
    return () => this.unclaimedListeners.delete(listener);
  }

  /** Stands in for the main process broadcasting the set of runs in flight. */
  emitRuns(runs: ActiveRun[]): void {
    for (const listener of this.runListeners) listener(runs);
  }

  /** Stands in for an event whose request this window never issued. */
  emitUnclaimed(requestId: string, event: ApplicationEvent): void {
    for (const listener of this.unclaimedListeners) listener(requestId, event);
  }

  async send(
    command: ApplicationCommand,
    onEvent: (event: ApplicationEvent) => void = () => {},
  ): Promise<void> {
    this.commands.push(command);
    if (command.type !== "prompt") return;
    return new Promise<void>((resolve, reject) => {
      this.run = { emit: onEvent, finish: resolve, fail: reject };
    });
  }

  async collect<T extends ApplicationEvent["type"]>(
    command: ApplicationCommand,
    type: T,
  ): Promise<Extract<ApplicationEvent, { type: T }>> {
    this.commands.push(command);
    const make = (): ApplicationEvent => {
      switch (command.type) {
        case "list_sessions":
          return { type: "sessions", sessions: this.sessions };
        case "get_session":
          return { type: "session_view", view: this.views.get(command.sessionId)! };
        case "create_session":
          return { type: "session_view", view: view("new") };
        case "set_thinking":
          return {
            type: "state_updated",
            sessionId: command.sessionId,
            state: { thinking: command.thinking },
          };
        case "rename_session":
          return {
            type: "session_renamed",
            session: { id: command.sessionId, createdAt: at, name: command.name },
          };
        default:
          throw new Error(`unhandled ${command.type}`);
      }
    };
    return make() as Extract<ApplicationEvent, { type: T }>;
  }
}

function setup() {
  const gateway = new StubGateway();
  gateway.sessions = [view("a").session, view("b").session];
  gateway.views.set("a", view("a"));
  gateway.views.set("b", view("b"));
  return { gateway, store: new AgentStore(gateway) };
}

describe("session restore", () => {
  test("lists sessions and opens the newest one", async () => {
    const { store } = setup();
    await store.restoreSessions();

    expect(store.getSnapshot().sessions).toHaveLength(2);
    expect(store.getSnapshot().currentSessionId).toBe("a");
    expect(store.getSnapshot().currentTitle).toBe("chat a");
  });

  test("reopens the session that was selected last time", async () => {
    localStorage.setItem("OpenScreenSelectedSessionID:main", "b");
    const { store } = setup();
    await store.restoreSessions();

    expect(store.getSnapshot().currentSessionId).toBe("b");
  });

  test("keeps the overlay and main window selections apart", async () => {
    localStorage.setItem("OpenScreenSelectedSessionID:main", "b");
    const gateway = new StubGateway();
    gateway.sessions = [view("a").session, view("b").session];
    gateway.views.set("a", view("a"));
    gateway.views.set("b", view("b"));

    const overlay = new AgentStore(gateway, "overlay");
    await overlay.restoreSessions();

    // The two renderers share an origin, so an unscoped key would have dragged
    // the overlay to whatever the main window opened last.
    expect(overlay.getSnapshot().currentSessionId).toBe("a");
    expect(localStorage.getItem("OpenScreenSelectedSessionID:main")).toBe("b");
    expect(localStorage.getItem("OpenScreenSelectedSessionID:overlay")).toBe("a");
  });

  test("creates the first chat when none exist", async () => {
    const { gateway, store } = setup();
    gateway.sessions = [];
    await store.restoreSessions();

    expect(gateway.commands.map((command) => command.type)).toContain("create_session");
    expect(store.getSnapshot().currentSessionId).toBe("new");
  });

  test("reports a readable error when the runtime cannot be reached", async () => {
    const { gateway, store } = setup();
    gateway.collect = vi.fn(async () => {
      throw new Error("stdin closed");
    }) as never;
    await store.restoreSessions();

    expect(store.getSnapshot().sessionError).toBe("Couldn't load chats. Please try again.");
  });
});

describe("prompt lifecycle", () => {
  async function started() {
    const { gateway, store } = setup();
    await store.restoreSessions();
    store.updateDraft("why is this failing");
    store.submit();
    return { gateway, store };
  }

  test("clears the composer and shows the turn as soon as it is sent", async () => {
    const { store } = await started();

    expect(store.getSnapshot().composer.draft).toBe("");
    expect(store.getSnapshot().turns).toHaveLength(1);
    expect(store.getSnapshot().turns[0]).toMatchObject({
      question: "why is this failing",
      status: "capturing",
    });
  });

  test("applies streaming deltas in order", async () => {
    const { gateway, store } = await started();
    const turnId = store.getSnapshot().turns[0]!.id;

    gateway.run!.emit({ type: "run_started", sessionId: "a" });
    expect(store.getSnapshot().turns[0]?.status).toBe("requesting");

    gateway.run!.emit({ type: "reasoning_delta", sessionId: "a", delta: "hm" });
    gateway.run!.emit({ type: "answer_delta", sessionId: "a", delta: "be" });
    gateway.run!.emit({ type: "answer_delta", sessionId: "a", delta: "cause" });

    expect(store.getSnapshot().turns[0]).toMatchObject({
      id: turnId,
      status: "generating",
      reasoning: "hm",
      answer: "because",
    });
  });

  test("accepts another prompt after the shared run set closes first", async () => {
    const { gateway, store } = await started();
    const turnId = store.getSnapshot().turns[0]!.id;

    // The main process settles the shared run set inside its event handler and
    // forwards the terminal event afterwards, so the window is told the run
    // closed before the send it is still awaiting resolves. That ordering must
    // not strand the session as busy.
    gateway.emitRuns([
      { sessionId: "a", requestId: turnId, text: "why is this failing", startedAt: at },
    ]);
    gateway.emitRuns([]);
    gateway.run!.finish();

    await vi.waitFor(() =>
      expect(store.getSnapshot().activeSessionIds).not.toContain("a"),
    );
    expect(store.isSending).toBe(false);

    store.updateDraft("and now this one");
    store.submit();

    expect(
      gateway.commands.filter((command) => command.type === "prompt"),
    ).toHaveLength(2);
  });

  test("does not duplicate its own turn when the run set names it", async () => {
    const { gateway, store } = await started();
    const turnId = store.getSnapshot().turns[0]!.id;

    gateway.emitRuns([
      { sessionId: "a", requestId: turnId, text: "why is this failing", startedAt: at },
    ]);

    expect(store.getSnapshot().turns).toHaveLength(1);
    expect(store.getSnapshot().turns[0]?.id).toBe(turnId);
  });

  test("tracks a tool from start to finish under one call id", async () => {
    const { gateway, store } = await started();

    gateway.run!.emit({
      type: "tool_started",
      sessionId: "a",
      callId: "c1",
      name: "bash",
      input: {},
    });
    expect(store.getSnapshot().turns[0]?.toolActivities[0]).toMatchObject({
      name: "bash",
      status: "running",
    });

    gateway.run!.emit({
      type: "tool_finished",
      sessionId: "a",
      callId: "c1",
      name: "bash",
      text: "1 failing",
      isError: true,
    });
    expect(store.getSnapshot().turns[0]?.toolActivities).toHaveLength(1);
    expect(store.getSnapshot().turns[0]?.toolActivities[0]).toMatchObject({
      status: "finished",
      isError: true,
      text: "1 failing",
    });
  });

  test("records the final answer and its context cost", async () => {
    const { gateway, store } = await started();
    gateway.run!.emit({
      type: "answer_completed",
      sessionId: "a",
      answer: "the whole answer",
      contextUsage: { contextTokens: 8200, contextWindow: 200000 },
    });

    expect(store.getSnapshot().turns[0]).toMatchObject({
      status: "completed",
      answer: "the whole answer",
      contextUsage: { contextTokens: 8200, contextWindow: 200000 },
    });
  });

  test("ignores events addressed to a different session", async () => {
    const { gateway, store } = await started();
    gateway.run!.emit({ type: "answer_delta", sessionId: "b", delta: "wrong" });

    expect(store.getSnapshot().turns[0]?.answer).toBe("");
  });

  test("marks the turn aborted rather than failed when the user stops it", async () => {
    const { gateway, store } = await started();
    gateway.run!.fail(
      new AgentFailureError({ code: "aborted", message: "Run aborted" }),
    );
    await vi.waitFor(() => expect(store.getSnapshot().turns[0]?.status).toBe("aborted"));
    expect(store.getSnapshot().turns[0]?.error).toBeUndefined();
  });

  test("surfaces a provider failure on the turn", async () => {
    const { gateway, store } = await started();
    gateway.run!.fail(
      new AgentFailureError({ code: "provider", message: "no credential" }),
    );
    await vi.waitFor(() => expect(store.getSnapshot().turns[0]?.status).toBe("failed"));
    expect(store.getSnapshot().turns[0]?.error).toBe("no credential");
  });

  test("releases the session once the run settles", async () => {
    const { gateway, store } = await started();
    expect(store.getSnapshot().activeSessionIds).toEqual(["a"]);

    gateway.run!.finish();
    await vi.waitFor(() =>
      expect(store.getSnapshot().activeSessionIds).toEqual([]),
    );
  });

  test("refuses a second prompt while one is in flight", async () => {
    const { gateway, store } = await started();
    store.updateDraft("another");
    store.submit();

    expect(store.getSnapshot().turns).toHaveLength(1);
    expect(gateway.commands.filter((c) => c.type === "prompt")).toHaveLength(1);
  });

  test("ignores an empty or whitespace-only draft", async () => {
    const { gateway, store } = setup();
    await store.restoreSessions();
    store.updateDraft("   ");
    store.submit();

    expect(gateway.commands.filter((c) => c.type === "prompt")).toHaveLength(0);
  });

  test("aborts against the request id of the running turn", async () => {
    const { gateway, store } = await started();
    const turnId = store.getSnapshot().turns[0]!.id;
    store.cancelCurrentRequest();

    const abort = gateway.commands.find((command) => command.type === "abort");
    expect(abort).toMatchObject({ type: "abort", sessionId: "a", targetRequestId: turnId });
  });

  test("retry puts a failed question back in the composer", async () => {
    const { gateway, store } = await started();
    gateway.run!.fail(new AgentFailureError({ code: "provider", message: "down" }));
    await vi.waitFor(() => expect(store.getSnapshot().turns[0]?.status).toBe("failed"));

    store.retry(store.getSnapshot().turns[0]!.id);
    expect(store.getSnapshot().composer.draft).toBe("why is this failing");
  });
});

describe("switching sessions", () => {
  test("keeps a running turn accumulating in the session it belongs to", async () => {
    const { gateway, store } = setup();
    await store.restoreSessions();
    store.updateDraft("first");
    store.submit();

    store.selectSession("b");
    await vi.waitFor(() => expect(store.getSnapshot().currentSessionId).toBe("b"));
    expect(store.getSnapshot().turns).toHaveLength(0);

    gateway.run!.emit({ type: "answer_delta", sessionId: "a", delta: "kept" });

    store.selectSession("a");
    await vi.waitFor(() => expect(store.getSnapshot().currentSessionId).toBe("a"));
    expect(store.getSnapshot().turns[0]?.answer).toBe("kept");
  });

  test("keeps each session's draft separate", async () => {
    const { store } = setup();
    await store.restoreSessions();
    store.updateDraft("draft for a");

    store.selectSession("b");
    await vi.waitFor(() => expect(store.getSnapshot().currentSessionId).toBe("b"));
    expect(store.getSnapshot().composer.draft).toBe("");

    store.selectSession("a");
    await vi.waitFor(() => expect(store.getSnapshot().currentSessionId).toBe("a"));
    expect(store.getSnapshot().composer.draft).toBe("draft for a");
  });

  test("remembers the selection for the next launch", async () => {
    const { store } = setup();
    await store.restoreSessions();
    store.selectSession("b");
    await vi.waitFor(() =>
      expect(localStorage.getItem("OpenScreenSelectedSessionID:main")).toBe("b"),
    );
  });
});

describe("runs started in the other window", () => {
  const remote: ActiveRun = {
    sessionId: "a",
    requestId: "remote-1",
    text: "what changed here",
    startedAt: at,
  };

  async function observing() {
    const { gateway, store } = setup();
    await store.restoreSessions();
    return { gateway, store };
  }

  test("adopts the run into the transcript it is already showing", async () => {
    const { gateway, store } = await observing();

    gateway.emitRuns([remote]);

    expect(store.getSnapshot().turns).toHaveLength(1);
    expect(store.getSnapshot().turns[0]).toMatchObject({
      id: "remote-1",
      question: "what changed here",
      status: "requesting",
    });
  });

  test("streams events it never asked for into that turn", async () => {
    const { gateway, store } = await observing();
    gateway.emitRuns([remote]);

    gateway.emitUnclaimed("remote-1", {
      type: "answer_delta",
      sessionId: "a",
      delta: "the capture rule",
    });

    expect(store.getSnapshot().turns[0]).toMatchObject({
      status: "generating",
      answer: "the capture rule",
    });
  });

  test("offers to stop the remote run instead of starting a second one", async () => {
    const { gateway, store } = await observing();
    gateway.emitRuns([remote]);

    expect(store.getSnapshot().activeSessionIds).toContain("a");
    expect(store.isSending).toBe(true);

    // The runtime rejects a second prompt on a busy session, so the composer
    // must not send one.
    store.updateDraft("meanwhile");
    store.submit();
    expect(gateway.commands.some((command) => command.type === "prompt")).toBe(false);

    store.cancelCurrentRequest();
    expect(gateway.commands).toContainEqual(
      expect.objectContaining({
        type: "abort",
        sessionId: "a",
        targetRequestId: "remote-1",
      }),
    );
  });

  test("re-reads the session from disk once the remote run ends", async () => {
    const { gateway, store } = await observing();
    gateway.emitRuns([remote]);
    gateway.views.set(
      "a",
      view("a", [
        { id: "m1", role: "user", timestamp: at, text: "what changed here" },
        { id: "m2", role: "assistant", timestamp: at, text: "the capture rule" },
      ]),
    );

    gateway.emitRuns([]);

    // The streamed increments cannot reproduce the stored projection, so the
    // finished turn comes back from the session file rather than the guesses.
    await vi.waitFor(() => {
      expect(store.getSnapshot().activeSessionIds).not.toContain("a");
      expect(store.getSnapshot().turns[0]).toMatchObject({
        question: "what changed here",
        answer: "the capture rule",
        status: "completed",
      });
    });
  });

  test("re-reads the chat list when the other window changes it", async () => {
    const { gateway, store } = await observing();
    expect(store.getSnapshot().sessions).toHaveLength(2);

    gateway.sessions = [...gateway.sessions, view("c").session];
    gateway.emitSessionsInvalidated();

    await vi.waitFor(() =>
      expect(store.getSnapshot().sessions.map((session) => session.id)).toEqual([
        "a",
        "b",
        "c",
      ]),
    );
  });

  test("picks up a rename of the chat it is showing", async () => {
    const { gateway, store } = await observing();
    expect(store.getSnapshot().currentTitle).toBe("chat a");

    gateway.sessions = [
      { id: "a", createdAt: at, name: "the capture rule" },
      view("b").session,
    ];
    gateway.emitSessionsInvalidated();

    // A chat with no explicit name takes it from its first question, so the
    // open chat's title goes stale the same way the list does.
    await vi.waitFor(() =>
      expect(store.getSnapshot().currentTitle).toBe("the capture rule"),
    );
  });

  test("ignores a run in a session this window has not opened", async () => {
    const { gateway, store } = await observing();

    gateway.emitRuns([{ ...remote, sessionId: "b", requestId: "remote-2" }]);

    expect(store.getSnapshot().turns).toHaveLength(0);
    // The chat list still marks it, so the other window's work is visible.
    expect(store.getSnapshot().activeSessionIds).toContain("b");
  });
});

describe("agent settings", () => {
  test("applies a new thinking level to the current session", async () => {
    const { store } = setup();
    await store.restoreSessions();
    await store.selectThinking("high");

    expect(store.getSnapshot().thinking).toBe("high");
  });

  test("renames a session in place", async () => {
    const { store } = setup();
    await store.restoreSessions();
    store.renameSession("a", "the abort race");
    await vi.waitFor(() =>
      expect(store.getSnapshot().currentTitle).toBe("the abort race"),
    );
  });

  test("does not rename a session that is running", async () => {
    const { gateway, store } = setup();
    await store.restoreSessions();
    store.updateDraft("q");
    store.submit();
    store.renameSession("a", "nope");

    expect(gateway.commands.filter((c) => c.type === "rename_session")).toHaveLength(0);
  });
});
