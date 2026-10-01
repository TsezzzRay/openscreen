import { expect, test, vi } from "vitest";

import type { ActiveRun, AgentStatus } from "../src/shared/ipc.ts";
import type { ApplicationCommand, ApplicationEvent, ProductSessionView } from "../src/shared/protocol.ts";
import { AgentStore } from "../src/renderer/store/agent-store.ts";
import type { AgentGateway } from "../src/renderer/store/transport.ts";

const sessionId = "session-1";
const view: ProductSessionView = {
  session: { id: sessionId, createdAt: "2026-09-26T00:00:00.000Z" },
  messages: [],
  state: { thinking: "medium" },
};

class Gateway implements AgentGateway {
  emit?: (event: ApplicationEvent) => void;
  finish?: () => void;
  onStatus(_listener: (status: AgentStatus) => void) { return () => {}; }
  onActiveRuns(_listener: (runs: ActiveRun[]) => void) { return () => {}; }
  onSessionsInvalidated(_listener: () => void) { return () => {}; }
  onUnclaimedEvent(_listener: (requestId: string, event: ApplicationEvent) => void) { return () => {}; }
  async send(command: ApplicationCommand, onEvent: (event: ApplicationEvent) => void = () => {}) {
    if (command.type !== "prompt") return;
    this.emit = onEvent;
    await new Promise<void>(resolve => { this.finish = resolve; });
  }
  async collect<T extends ApplicationEvent["type"]>(command: ApplicationCommand, _type: T): Promise<Extract<ApplicationEvent, { type: T }>> {
    const event: ApplicationEvent = command.type === "list_sessions"
      ? { type: "sessions", sessions: [view.session] }
      : { type: "session_view", view };
    return event as Extract<ApplicationEvent, { type: T }>;
  }
}

test("approval and commit remain distinct in the Turn after its session refresh", async () => {
  const gateway = new Gateway();
  const store = new AgentStore(gateway);
  await store.restoreSessions();
  store.updateDraft("Update the file");
  store.submit();
  expect(gateway.emit).toBeDefined();
  gateway.emit!({ type: "approval_requested", sessionId, request: {
    id: "approval-1", sessionId, callId: "call-1", tool: "write", target: "/tmp/result.txt", proposedContent: "new",
  } });
  gateway.emit!({ type: "approval_decided", sessionId, id: "approval-1", approved: true });
  expect(store.getSnapshot().turns.at(-1)?.approvals).toMatchObject([{ status: "approved" }]);
  gateway.emit!({ type: "approval_committed", sessionId, id: "approval-1", callId: "call-1", tool: "write", target: "/tmp/result.txt" });
  expect(store.getSnapshot().turns.at(-1)?.approvals).toMatchObject([{ status: "committed", target: "/tmp/result.txt" }]);
  view.messages = [
    { id: "user-1", role: "user", timestamp: "2026-09-26T00:00:00.000Z", text: "Update the file" },
    { id: "tool-1", role: "tool", timestamp: "2026-09-26T00:00:01.000Z", text: "written", toolName: "write" },
    { id: "answer-1", role: "assistant", timestamp: "2026-09-26T00:00:02.000Z", text: "Done." },
  ];
  gateway.finish!();
  await vi.waitFor(() => expect(store.getSnapshot().turns[0]?.approvals).toMatchObject([{ status: "committed" }]));
});

test("each desktop action remains distinct when reusing an app approval", async () => {
  const gateway = new Gateway();
  const store = new AgentStore(gateway);
  await store.restoreSessions();
  store.updateDraft("Click then scroll");
  store.submit();
  gateway.emit!({ type: "approval_requested", sessionId, request: {
    id: "app-grant", sessionId, callId: "click-1", tool: "desktop_click", target: "click target",
  } });
  gateway.emit!({ type: "approval_decided", sessionId, id: "app-grant", approved: true });
  gateway.emit!({ type: "approval_committed", sessionId, id: "app-grant", callId: "click-1", tool: "desktop_click", target: "click target" });
  const scroll = { type: "approval_committed", sessionId, id: "app-grant", callId: "scroll-1", tool: "desktop_scroll", target: "scroll target" } as const;
  gateway.emit!(scroll);
  gateway.emit!(scroll);
  expect(store.getSnapshot().turns.at(-1)?.approvals).toMatchObject([
    { id: "app-grant", callId: "click-1", tool: "desktop_click", status: "committed", target: "click target" },
    { id: "app-grant", callId: "scroll-1", tool: "desktop_scroll", status: "committed", target: "scroll target" },
  ]);
  gateway.finish!();
});
