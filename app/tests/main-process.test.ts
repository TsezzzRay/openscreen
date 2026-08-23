import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import type { ActiveRun } from "@shared/ipc.ts";

vi.mock("electron", () => ({
  nativeImage: { createFromBuffer: vi.fn() },
  protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() },
  BrowserWindow: class {},
  screen: {},
  shell: {},
}));

const { AttachmentStore, attachmentUrl } = await import("@/../main/attachments.ts");
const { AgentClient } = await import("@/../main/agent-client.ts");
const { overlayHeight, OVERLAY_COLLAPSED_HEIGHT, OVERLAY_MAX_HEIGHT } = await import(
  "@/../main/windows/overlay.ts"
);
const { SessionHub } = await import("@/../main/session-hub.ts");

describe("AttachmentStore path guard", () => {
  const store = new AttachmentStore("/data/OpenScreen/user-attachments");

  test("accepts a file inside the store", () => {
    expect(store.contains("/data/OpenScreen/user-attachments/a.png")).toBe(true);
  });

  test("rejects a path outside the store", () => {
    expect(store.contains("/etc/passwd")).toBe(false);
  });

  test("rejects traversal back out of the store", () => {
    expect(
      store.contains("/data/OpenScreen/user-attachments/../../../etc/passwd"),
    ).toBe(false);
  });

  test("rejects a sibling directory that shares the prefix", () => {
    expect(store.contains("/data/OpenScreen/user-attachments-other/a.png")).toBe(false);
  });

  test("rejects the store directory itself", () => {
    expect(store.contains("/data/OpenScreen/user-attachments")).toBe(false);
  });

  test("encodes the path so a custom-scheme URL round-trips", () => {
    const path = "/data/OpenScreen/user-attachments/a b.png";
    expect(decodeURIComponent(new URL(attachmentUrl(path)).pathname.slice(1))).toBe(path);
  });
});

describe("overlay height", () => {
  test("never collapses below the command bar", () => {
    expect(overlayHeight(10)).toBe(OVERLAY_COLLAPSED_HEIGHT);
  });

  test("never grows past the panel ceiling", () => {
    expect(overlayHeight(5000)).toBe(OVERLAY_MAX_HEIGHT);
  });

  test("follows the content between those bounds", () => {
    expect(overlayHeight(240.4)).toBe(240);
  });

  test("falls back to the collapsed height for a non-finite measurement", () => {
    expect(overlayHeight(Number.NaN)).toBe(OVERLAY_COLLAPSED_HEIGHT);
  });
});

describe("SessionHub", () => {
  const prompt = {
    requestId: "r1",
    type: "prompt" as const,
    sessionId: "s1",
    input: { text: "what is this" },
  };

  function hub() {
    const changes: ActiveRun[][] = [];
    let invalidations = 0;
    const instance = new SessionHub({
      onRuns: (runs) => changes.push(runs),
      onSessionsChanged: () => {
        invalidations += 1;
      },
      now: () => new Date("2026-08-22T00:00:00.000Z"),
    });
    return { changes, hub: instance, invalidated: () => invalidations };
  }

  test("opens a run from a prompt command and carries its question", () => {
    const { changes, hub: instance } = hub();
    instance.observeCommand(prompt);

    // The event stream never repeats the question, so the other window has no
    // other way to label the turn it is adopting.
    expect(instance.activeRuns).toEqual([{
      sessionId: "s1",
      requestId: "r1",
      text: "what is this",
      startedAt: "2026-08-22T00:00:00.000Z",
    }]);
    expect(changes).toHaveLength(1);
  });

  test("ignores commands that are not prompts", () => {
    const { changes, hub: instance } = hub();
    instance.observeCommand({ requestId: "r2", type: "list_sessions" });

    expect(instance.activeRuns).toEqual([]);
    expect(changes).toHaveLength(0);
  });

  test("closes the run on its terminal event and only then", () => {
    const { hub: instance } = hub();
    instance.observeCommand(prompt);

    instance.observeEvent({
      requestId: "r1",
      event: { type: "answer_delta", sessionId: "s1", delta: "hm" },
    });
    expect(instance.activeRuns).toHaveLength(1);

    instance.observeEvent({ requestId: "r1", event: { type: "completed" } });
    expect(instance.activeRuns).toEqual([]);
  });

  test("closes a failed run and stays quiet for unknown requests", () => {
    const { changes, hub: instance } = hub();
    instance.observeCommand(prompt);
    instance.observeEvent({
      requestId: "other",
      event: { type: "completed" },
    });
    expect(changes).toHaveLength(1);

    instance.observeEvent({
      requestId: "r1",
      event: { type: "failed", error: { code: "provider", message: "no" } },
    });
    expect(instance.activeRuns).toEqual([]);
    expect(changes).toHaveLength(2);
  });

  test("invalidates the chat list once a prompt settles", () => {
    const { hub: instance, invalidated } = hub();
    instance.observeCommand(prompt);
    // A chat with no explicit name takes it from the first question, so the
    // turn that starts a chat also renames it.
    expect(invalidated()).toBe(0);

    instance.observeEvent({ requestId: "r1", event: { type: "completed" } });
    expect(invalidated()).toBe(1);
  });

  test("invalidates for creates and renames, but not for other commands", () => {
    const { hub: instance, invalidated } = hub();
    instance.observeCommand({ requestId: "c1", type: "create_session" });
    instance.observeCommand({
      requestId: "n1",
      type: "rename_session",
      sessionId: "s1",
      name: "the capture rule",
    });
    instance.observeCommand({
      requestId: "t1",
      type: "set_thinking",
      sessionId: "s1",
      thinking: "high",
    });

    for (const requestId of ["c1", "n1", "t1"]) {
      instance.observeEvent({ requestId, event: { type: "completed" } });
    }
    expect(invalidated()).toBe(2);
  });

  test("invalidates on a failed request too", () => {
    const { hub: instance, invalidated } = hub();
    instance.observeCommand(prompt);

    // The question can reach the session before whatever failed the run.
    instance.observeEvent({
      requestId: "r1",
      event: { type: "failed", error: { code: "provider", message: "no" } },
    });
    expect(invalidated()).toBe(1);
  });

  test("settles each request only once", () => {
    const { hub: instance, invalidated } = hub();
    instance.observeCommand(prompt);
    instance.observeEvent({ requestId: "r1", event: { type: "completed" } });
    instance.observeEvent({ requestId: "r1", event: { type: "completed" } });

    expect(invalidated()).toBe(1);
  });

  test("drops every run when the runtime stops", () => {
    const { hub: instance } = hub();
    instance.observeCommand(prompt);
    instance.observeCommand({ ...prompt, requestId: "r2", sessionId: "s2" });

    instance.clear();
    expect(instance.activeRuns).toEqual([]);
    // Nothing is left to clear, so no second broadcast.
    instance.clear();
  });
});

describe("AgentClient over stdio", () => {
  const clients: InstanceType<typeof AgentClient>[] = [];

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.stop()));
  });

  /** Starts a real child speaking the runtime's newline-delimited JSON. */
  async function start(script: string) {
    const dir = await mkdtemp(join(tmpdir(), "openscreen-agent-"));
    const file = join(dir, "fake-runtime.mjs");
    await writeFile(file, script);
    const client = new AgentClient({
      command: process.execPath,
      args: [file],
      cwd: dir,
      env: { ...process.env },
      onStderr: () => {},
    });
    clients.push(client);
    client.start();
    return client;
  }

  const ECHO = `
import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const command = JSON.parse(line);
  process.stdout.write(JSON.stringify({ requestId: command.requestId, type: "sessions", sessions: [] }) + "\\n");
  process.stdout.write(JSON.stringify({ requestId: command.requestId, type: "completed" }) + "\\n");
}
`;

  test("correlates a reply with the command that asked for it", async () => {
    const client = await start(ECHO);
    const received: { requestId: string; type: string }[] = [];
    client.on("event", ({ requestId, event }) =>
      received.push({ requestId, type: event.type }),
    );

    client.send({ requestId: "r1", type: "list_sessions" });
    await vi.waitFor(() => expect(received).toHaveLength(2), { timeout: 5000 });
    expect(received).toEqual([
      { requestId: "r1", type: "sessions" },
      { requestId: "r1", type: "completed" },
    ]);
  });

  test("reassembles events split across stdout chunks", async () => {
    const client = await start(`
process.stdin.resume();
const line = JSON.stringify({ requestId: "r1", type: "completed" }) + "\\n";
for (const character of line) {
  process.stdout.write(character);
}
`);
    const received: string[] = [];
    client.on("event", ({ event }) => received.push(event.type));
    await vi.waitFor(() => expect(received).toEqual(["completed"]), { timeout: 5000 });
  });

  test("reports the process stopping instead of hanging the caller", async () => {
    const client = await start(`process.exit(3);`);
    const statuses: string[] = [];
    client.on("status", (status) => statuses.push(status.state));
    await vi.waitFor(() => expect(statuses).toContain("stopped"), { timeout: 5000 });
    expect(client.running).toBe(false);
  });

  test("refuses to send once the process has gone", async () => {
    const client = await start(`process.exit(0);`);
    await vi.waitFor(() => expect(client.running).toBe(false), { timeout: 5000 });
    expect(() => client.send({ requestId: "r1", type: "list_sessions" })).toThrow(
      "not running",
    );
  });

  test("shuts the child down by closing stdin", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openscreen-agent-"));
    const marker = join(dir, "closed.txt");
    const file = join(dir, "fake-runtime.mjs");
    await writeFile(
      file,
      `
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin });
for await (const line of lines) void line;
writeFileSync(${JSON.stringify(marker)}, "closed");
`,
    );
    const client = new AgentClient({
      command: process.execPath,
      args: [file],
      cwd: dir,
      env: { ...process.env },
      onStderr: () => {},
    });
    client.start();
    await client.stop();
    await vi.waitFor(async () => expect(await readFile(marker, "utf8")).toBe("closed"), {
      timeout: 5000,
    });
  });

  test("keeps stdout framing intact when a line is not valid JSON", async () => {
    const reported: string[] = [];
    const dir = await mkdtemp(join(tmpdir(), "openscreen-agent-"));
    const file = join(dir, "fake-runtime.mjs");
    await writeFile(
      file,
      `
process.stdin.resume();
process.stdout.write("not json\\n");
process.stdout.write(JSON.stringify({ requestId: "r1", type: "completed" }) + "\\n");
`,
    );
    const client = new AgentClient({
      command: process.execPath,
      args: [file],
      cwd: dir,
      env: { ...process.env },
      onStderr: (line) => reported.push(line),
    });
    clients.push(client);
    const received: string[] = [];
    client.on("event", ({ event }) => received.push(event.type));
    client.start();

    await vi.waitFor(() => expect(received).toEqual(["completed"]), { timeout: 5000 });
    expect(reported.some((line) => line.includes("Unparseable"))).toBe(true);
  });
});
