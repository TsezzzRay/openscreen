import { expect, test } from "vitest";

import type { ActiveRun, AgentStatus } from "@shared/ipc.ts";
import type { ApplicationCommand, ApplicationEvent } from "@shared/protocol.ts";
import { AgentStore } from "../src/renderer/store/agent-store.ts";
import type { AgentGateway } from "../src/renderer/store/transport.ts";

class Gateway implements AgentGateway {
  commands: ApplicationCommand[] = [];
  sendError?: Error;
  approvalResponse?: Promise<Extract<ApplicationEvent, { type: "approvals" }>>;
  private statusListeners: Array<(status: AgentStatus) => void> = [];
  private observers: Array<(requestId: string, event: ApplicationEvent) => void> = [];
  onStatus(listener: (status: AgentStatus) => void) { this.statusListeners.push(listener); return () => {}; }
  onActiveRuns(_listener: (runs: ActiveRun[]) => void) { return () => {}; }
  onSessionsInvalidated(_listener: () => void) { return () => {}; }
  onUnclaimedEvent(listener: (requestId: string, event: ApplicationEvent) => void) { this.observers.push(listener); return () => {}; }
  emit(event: ApplicationEvent) { for (const observer of this.observers) observer("prompt-1", event); }
  setStatus(status: AgentStatus) { for (const listener of this.statusListeners) listener(status); }
  async send(command: ApplicationCommand) {
    this.commands.push(command);
    if (this.sendError) throw this.sendError;
  }
  async collect<T extends ApplicationEvent["type"]>(_command: ApplicationCommand, _type: T): Promise<Extract<ApplicationEvent, { type: T }>> {
    if (!this.approvalResponse) throw new Error("unused");
    return await this.approvalResponse as Extract<ApplicationEvent, { type: T }>;
  }
}

test("both surfaces can show and decide the same pending approval", async () => {
  const gateway = new Gateway();
  const main = new AgentStore(gateway, "main");
  const overlay = new AgentStore(gateway, "overlay");
  const request = { id: "approval-1", sessionId: "session-a", callId: "call-a", tool: "write" as const, target: "/tmp/config.txt", proposedContent: "new" };
  gateway.emit({ type: "approval_requested", sessionId: request.sessionId, request });
  expect(main.getSnapshot().approvals).toEqual([request]);
  expect(overlay.getSnapshot().approvals).toEqual([request]);
  await overlay.decideApproval(request.id, false);
  expect(gateway.commands.at(-1)).toMatchObject({ type: "decide_approval", approvalId: request.id, sessionId: request.sessionId, approved: false });
  gateway.emit({ type: "approval_decided", sessionId: request.sessionId, id: request.id, approved: false });
  expect(main.getSnapshot().approvals).toEqual([]);
  expect(overlay.getSnapshot().approvals).toEqual([]);
});

test("a stale approval snapshot cannot hide a newer request in either surface", async () => {
  const gateway = new Gateway();
  const main = new AgentStore(gateway, "main");
  const overlay = new AgentStore(gateway, "overlay");
  let resolveSnapshot!: (event: Extract<ApplicationEvent, { type: "approvals" }>) => void;
  gateway.approvalResponse = new Promise(resolve => { resolveSnapshot = resolve; });
  const refreshes = [main.refreshApprovals(), overlay.refreshApprovals()];
  const request = { id: "approval-1", sessionId: "session-a", callId: "call-a", tool: "bash" as const, target: "pwd" };
  gateway.emit({ type: "approval_requested", sessionId: request.sessionId, request });
  resolveSnapshot({ type: "approvals", requests: [] });
  await Promise.all(refreshes);
  expect(main.getSnapshot().approvals).toEqual([request]);
  expect(overlay.getSnapshot().approvals).toEqual([request]);
});

test("a stale approval snapshot cannot resurrect a decided request", async () => {
  const gateway = new Gateway();
  const main = new AgentStore(gateway, "main");
  const overlay = new AgentStore(gateway, "overlay");
  const request = { id: "approval-1", sessionId: "session-a", callId: "call-a", tool: "bash" as const, target: "pwd" };
  gateway.emit({ type: "approval_requested", sessionId: request.sessionId, request });
  let resolveSnapshot!: (event: Extract<ApplicationEvent, { type: "approvals" }>) => void;
  gateway.approvalResponse = new Promise(resolve => { resolveSnapshot = resolve; });
  const refreshes = [main.refreshApprovals(), overlay.refreshApprovals()];
  gateway.emit({ type: "approval_decided", sessionId: request.sessionId, id: request.id, approved: false });
  resolveSnapshot({ type: "approvals", requests: [request] });
  await Promise.all(refreshes);
  expect(main.getSnapshot().approvals).toEqual([]);
  expect(overlay.getSnapshot().approvals).toEqual([]);
});

test("a snapshot from a stopped runtime cannot restore an invalidated approval", async () => {
  const gateway = new Gateway();
  const store = new AgentStore(gateway, "main");
  const request = { id: "approval-1", sessionId: "session-a", callId: "call-a", tool: "bash" as const, target: "pwd" };
  let resolveSnapshot!: (event: Extract<ApplicationEvent, { type: "approvals" }>) => void;
  gateway.approvalResponse = new Promise(resolve => { resolveSnapshot = resolve; });
  const refresh = store.refreshApprovals();
  gateway.emit({ type: "approval_requested", sessionId: request.sessionId, request });
  gateway.setStatus({ state: "stopped", message: "Runtime exited" });
  expect(store.getSnapshot().approvals).toEqual([]);
  resolveSnapshot({ type: "approvals", requests: [request] });
  await refresh;
  expect(store.getSnapshot().approvals).toEqual([]);
});

test("a previous runtime snapshot cannot replace approvals loaded after restart", async () => {
  const gateway = new Gateway();
  const store = new AgentStore(gateway, "main");
  const oldRequest = { id: "old-approval", sessionId: "session-a", callId: "old-call", tool: "bash" as const, target: "pwd" };
  const newRequest = { id: "new-approval", sessionId: "session-b", callId: "new-call", tool: "bash" as const, target: "date" };
  let resolveOld!: (event: Extract<ApplicationEvent, { type: "approvals" }>) => void;
  gateway.approvalResponse = new Promise(resolve => { resolveOld = resolve; });
  const staleRefresh = store.refreshApprovals();
  gateway.setStatus({ state: "stopped", message: "Runtime exited" });
  gateway.approvalResponse = Promise.resolve({ type: "approvals", requests: [newRequest] });
  gateway.setStatus({ state: "ready" });
  await Promise.resolve();
  resolveOld({ type: "approvals", requests: [oldRequest] });
  await staleRefresh;
  expect(store.getSnapshot().approvals).toEqual([newRequest]);
});

test("a runtime stop clears an approval decision error from the previous run", async () => {
  const gateway = new Gateway();
  const store = new AgentStore(gateway, "main");
  const request = { id: "approval-1", sessionId: "session-a", callId: "call-a", tool: "bash" as const, target: "pwd" };
  gateway.emit({ type: "approval_requested", sessionId: request.sessionId, request });
  gateway.sendError = new Error("Decision unavailable");
  await store.decideApproval(request.id, false);
  expect(store.getSnapshot().approvalError).toBe("Decision unavailable");

  gateway.setStatus({ state: "stopped", message: "Runtime exited" });
  expect(store.getSnapshot().approvals).toEqual([]);
  expect(store.getSnapshot().approvalError).toBeUndefined();
});
