import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

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
