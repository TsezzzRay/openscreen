import { describe, expect, test, vi } from "vitest";

import type { AgentStatus } from "@shared/ipc.ts";
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

  onStatus(_listener: (status: AgentStatus) => void): () => void {
    return () => {};
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
    localStorage.setItem("OpenScreenSelectedSessionID", "b");
    const { store } = setup();
    await store.restoreSessions();

    expect(store.getSnapshot().currentSessionId).toBe("b");
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
      expect(localStorage.getItem("OpenScreenSelectedSessionID")).toBe("b"),
    );
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
