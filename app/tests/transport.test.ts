import { describe, expect, test, vi } from "vitest";

import type { AgentEventEnvelope, AgentStatus } from "@shared/ipc.ts";
import type { ApplicationCommand, ApplicationEvent } from "@shared/protocol.ts";

import { AgentFailureError, AgentTransport } from "@/store/transport.ts";

/** A stand-in for the preload bridge that lets a test drive the event stream. */
function harness() {
  const eventListeners: ((envelope: AgentEventEnvelope) => void)[] = [];
  const statusListeners: ((status: AgentStatus) => void)[] = [];
  const sent: ApplicationCommand[] = [];

  const bridge = {
    agent: {
      send: vi.fn(async (command: ApplicationCommand) => {
        sent.push(command);
      }),
      onEvent: (listener: (envelope: AgentEventEnvelope) => void) => {
        eventListeners.push(listener);
        return () => {};
      },
      onStatus: (listener: (status: AgentStatus) => void) => {
        statusListeners.push(listener);
        return () => {};
      },
    },
  };

  return {
    sent,
    transport: new AgentTransport(bridge as never),
    emit: (requestId: string, event: ApplicationEvent) => {
      for (const listener of eventListeners) listener({ requestId, event });
    },
    setStatus: (status: AgentStatus) => {
      for (const listener of statusListeners) listener(status);
    },
  };
}

describe("AgentTransport", () => {
  test("settles a request on its terminal completed event", async () => {
    const { transport, emit } = harness();
    const settled = transport.send({ requestId: "r1", type: "list_sessions" });
    emit("r1", { type: "completed" });
    await expect(settled).resolves.toBeUndefined();
  });

  test("routes events only to the request that owns the id", async () => {
    const { transport, emit } = harness();
    const seen: string[] = [];
    const settled = transport.send(
      { requestId: "r1", type: "list_sessions" },
      (event) => seen.push(event.type),
    );
    emit("other", { type: "sessions", sessions: [] });
    emit("r1", { type: "sessions", sessions: [] });
    emit("r1", { type: "completed" });
    await settled;
    expect(seen).toEqual(["sessions"]);
  });

  test("rejects with the runtime's failure so an abort stays distinguishable", async () => {
    const { transport, emit } = harness();
    const settled = transport.send({ requestId: "r1", type: "list_sessions" });
    emit("r1", { type: "failed", error: { code: "aborted", message: "Run aborted" } });

    await expect(settled).rejects.toBeInstanceOf(AgentFailureError);
    await settled.catch((error: unknown) => {
      expect(error).toBeInstanceOf(AgentFailureError);
      expect((error as AgentFailureError).aborted).toBe(true);
    });
  });

  test("treats a non-abort failure as an ordinary error", async () => {
    const { transport, emit } = harness();
    const settled = transport.send({ requestId: "r1", type: "list_sessions" });
    emit("r1", { type: "failed", error: { code: "provider", message: "no credential" } });
    await settled.catch((error: unknown) => {
      expect((error as AgentFailureError).aborted).toBe(false);
      expect((error as Error).message).toBe("no credential");
    });
  });

  test("collect returns the first event of the requested type", async () => {
    const { transport, emit } = harness();
    const collected = transport.collect(
      { requestId: "r1", type: "list_sessions" },
      "sessions",
    );
    emit("r1", { type: "sessions", sessions: [{ id: "a", createdAt: "now" }] });
    emit("r1", { type: "completed" });
    expect((await collected).sessions).toEqual([{ id: "a", createdAt: "now" }]);
  });

  test("collect rejects when the request completes without that event", async () => {
    const { transport, emit } = harness();
    const collected = transport.collect(
      { requestId: "r1", type: "list_sessions" },
      "sessions",
    );
    emit("r1", { type: "completed" });
    await expect(collected).rejects.toThrow("did not return a sessions response");
  });

  test("fails every in-flight request when the runtime process stops", async () => {
    const { transport, setStatus } = harness();
    const first = transport.send({ requestId: "r1", type: "list_sessions" });
    const second = transport.send({ requestId: "r2", type: "create_session" });
    setStatus({ state: "stopped", message: "The agent stopped." });

    await expect(first).rejects.toThrow("The agent stopped.");
    await expect(second).rejects.toThrow("The agent stopped.");
  });

  test("refuses to reuse a request id that is still in flight", async () => {
    const { transport, emit } = harness();
    const first = transport.send({ requestId: "r1", type: "list_sessions" });
    await expect(
      transport.send({ requestId: "r1", type: "list_sessions" }),
    ).rejects.toThrow("already running");
    emit("r1", { type: "completed" });
    await first;
  });

  test("ignores events that arrive after a request has settled", async () => {
    const { transport, emit } = harness();
    const seen: string[] = [];
    const settled = transport.send(
      { requestId: "r1", type: "list_sessions" },
      (event) => seen.push(event.type),
    );
    emit("r1", { type: "completed" });
    await settled;
    emit("r1", { type: "sessions", sessions: [] });
    expect(seen).toEqual([]);
  });
});
