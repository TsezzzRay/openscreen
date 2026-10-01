import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import test from "node:test";

import { ToolSecurity } from "../../src/security/tool-security.js";

async function pendingApproval(security: ToolSecurity) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const approval = security.approvals.pending()[0];
    if (approval) return approval;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error("Approval was not requested");
}

test("write in task output runs automatically; outside write waits for one exact approval", { skip: process.platform !== "darwin" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-tool-security-"));
  const requests: unknown[] = [];
  const security = new ToolSecurity({ cwd: root, dataRoot: root });
  try {
    const run = await security.prepare("session-a", event => { requests.push(event); });
    const write = security.tools.find(tool => tool.name === "write")!;
    const outputPath = join(run.outputRoot, "result.txt");
    const automatic = await run.execute(() => write.execute("call-output", { path: outputPath, content: "ok" }, new AbortController().signal));
    assert.equal(await readFile(outputPath, "utf8"), "ok");
    assert.doesNotMatch(JSON.stringify(automatic.content), /User approved this one-time change/);
    assert.deepEqual(requests, []);
    const outside = join(root, "config.txt");
    const pending = run.execute(() => write.execute("call-outside", { path: outside, content: "approved" }, new AbortController().signal));
    void pending.catch(() => {});
    const approval = await pendingApproval(security);
    assert.equal(approval.target, join(await realpath(root), "config.txt"));
    await assert.rejects(readFile(outside));
    assert.equal(security.approvals.decide(approval.id, true), true);
    const approvedResult = await pending;
    assert.equal(await readFile(outside, "utf8"), "approved");
    assert.match(JSON.stringify(approvedResult.content), /User approved this one-time change to .*config\.txt/);
    assert.match(approvedResult.content.map(block => block.type === "text" ? block.text : "").join(""), /config\.txt\nUser approved this one-time change/);
    assert.equal(security.approvals.decide(approval.id, true), false);
  } finally {
    security.approvals.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("write creates nested task-output directories without approval", { skip: process.platform !== "darwin" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-tool-security-"));
  const security = new ToolSecurity({ cwd: root, dataRoot: root });
  try {
    const run = await security.prepare("session-a", () => {});
    const write = security.tools.find(tool => tool.name === "write")!;
    const target = join(run.outputRoot, "nested", "report.txt");
    await run.execute(() => write.execute(
      "call-nested-output",
      { path: target, content: "saved" },
      new AbortController().signal,
    ));
    assert.equal(await readFile(target, "utf8"), "saved");
    assert.deepEqual(security.approvals.pending(), []);
  } finally {
    security.approvals.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("denied edit leaves source unchanged", { skip: process.platform !== "darwin" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-tool-security-"));
  const target = join(root, "config.txt");
  await writeFile(target, "timeout=3000");
  const security = new ToolSecurity({ cwd: root, dataRoot: root });
  try {
    const run = await security.prepare("session-a", () => {});
    const edit = security.tools.find(tool => tool.name === "edit")!;
    const pending = run.execute(() => edit.execute("call-edit", { path: target, edits: [{ oldText: "3000", newText: "4500" }] }, new AbortController().signal));
    const denied = assert.rejects(pending);
    const approval = await pendingApproval(security);
    assert.equal(security.approvals.decide(approval.id, false), true);
    await denied;
    assert.equal(await readFile(target, "utf8"), "timeout=3000");
  } finally {
    security.approvals.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("approved edit is invalidated when its source changes while paused", { skip: process.platform !== "darwin" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-tool-security-"));
  const target = join(root, "config.txt");
  await writeFile(target, "timeout=3000");
  const security = new ToolSecurity({ cwd: root, dataRoot: root });
  try {
    const run = await security.prepare("session-a", () => {});
    const edit = security.tools.find(tool => tool.name === "edit")!;
    const pending = run.execute(() => edit.execute("call-edit", { path: target, edits: [{ oldText: "3000", newText: "4500" }] }, new AbortController().signal));
    const rejected = assert.rejects(pending, /Source changed after approval/);
    const approval = await pendingApproval(security);
    assert.equal(approval.expectedContent, "timeout=3000");
    assert.equal(approval.proposedContent, "timeout=4500");
    await writeFile(target, "timeout=9000");
    security.approvals.decide(approval.id, true);
    await rejected;
    assert.equal(await readFile(target, "utf8"), "timeout=9000");
  } finally {
    security.approvals.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("approved replacement is invalidated when the target changes while paused", { skip: process.platform !== "darwin" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-tool-security-"));
  const target = join(root, "config.txt");
  await writeFile(target, "old");
  const security = new ToolSecurity({ cwd: root, dataRoot: root });
  try {
    const run = await security.prepare("session-a", () => {});
    const write = security.tools.find(tool => tool.name === "write")!;
    const pending = run.execute(() => write.execute("call-write", { path: target, content: "new" }, new AbortController().signal));
    const rejected = assert.rejects(pending, /Source changed after approval/);
    const approval = await pendingApproval(security);
    assert.equal(approval.expectedContent, "old");
    await writeFile(target, "someone else's change");
    security.approvals.decide(approval.id, true);
    await rejected;
    assert.equal(await readFile(target, "utf8"), "someone else's change");
  } finally {
    security.approvals.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("approval binds the canonical destination when a parent symlink changes", { skip: process.platform !== "darwin" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-tool-security-"));
  const first = join(root, "first");
  const second = join(root, "second");
  const alias = join(root, "alias");
  await mkdir(first);
  await mkdir(second);
  await symlink(first, alias);
  const security = new ToolSecurity({ cwd: root, dataRoot: root });
  try {
    const run = await security.prepare("session-a", () => {});
    const write = security.tools.find(tool => tool.name === "write")!;
    const pending = run.execute(() => write.execute(
      "call-symlink",
      { path: join(alias, "config.txt"), content: "approved" },
      new AbortController().signal,
    ));
    void pending.catch(() => {});
    const approval = await pendingApproval(security);
    assert.equal(approval.target, join(await realpath(first), "config.txt"));
    await rm(alias);
    await symlink(second, alias);
    security.approvals.decide(approval.id, true);
    await pending;
    assert.equal(await readFile(join(first, "config.txt"), "utf8"), "approved");
    await assert.rejects(readFile(join(second, "config.txt")));
  } finally {
    security.approvals.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("approval displays the resolved file when the target itself is a symlink", { skip: process.platform !== "darwin" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-tool-security-"));
  const destination = join(root, "actual.txt");
  const alias = join(root, "alias.txt");
  await writeFile(destination, "old");
  await symlink(destination, alias);
  const security = new ToolSecurity({ cwd: root, dataRoot: root });
  try {
    const run = await security.prepare("session-a", () => {});
    const write = security.tools.find(tool => tool.name === "write")!;
    const pending = run.execute(() => write.execute(
      "call-file-symlink",
      { path: alias, content: "new" },
      new AbortController().signal,
    ));
    void pending.catch(() => {});
    const approval = await pendingApproval(security);
    assert.equal(approval.target, await realpath(destination));
    assert.equal(approval.expectedContent, "old");
    security.approvals.decide(approval.id, true);
    await pending;
    assert.equal(await readFile(destination, "utf8"), "new");
  } finally {
    security.approvals.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a task-output symlink to another file requires approval for its resolved destination", { skip: process.platform !== "darwin" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-tool-security-"));
  const destination = join(root, "outside.txt");
  await writeFile(destination, "old");
  const security = new ToolSecurity({ cwd: root, dataRoot: root });
  try {
    const run = await security.prepare("session-a", () => {});
    const alias = join(run.outputRoot, "alias.txt");
    await symlink(destination, alias);
    const write = security.tools.find(tool => tool.name === "write")!;
    const pending = run.execute(() => write.execute(
      "call-output-alias",
      { path: alias, content: "new" },
      new AbortController().signal,
    ));
    const rejected = assert.rejects(pending);
    const approval = await pendingApproval(security);
    assert.equal(approval.target, await realpath(destination));
    assert.equal(await readFile(destination, "utf8"), "old");
    security.approvals.decide(approval.id, false);
    await rejected;
    assert.equal(await readFile(destination, "utf8"), "old");
  } finally {
    security.approvals.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("approved write is rejected if its canonical parent redirects while paused", { skip: process.platform !== "darwin" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-tool-security-"));
  const first = join(root, "first");
  const parked = join(root, "parked");
  const second = join(root, "second");
  await mkdir(first);
  await mkdir(second);
  const security = new ToolSecurity({ cwd: root, dataRoot: root });
  try {
    const run = await security.prepare("session-a", () => {});
    const write = security.tools.find(tool => tool.name === "write")!;
    const pending = run.execute(() => write.execute(
      "call-redirect",
      { path: join(first, "config.txt"), content: "approved" },
      new AbortController().signal,
    ));
    const rejected = assert.rejects(pending, /destination changed after approval/i);
    const approval = await pendingApproval(security);
    assert.equal(approval.target, join(await realpath(first), "config.txt"));
    await rename(first, parked);
    await symlink(second, first);
    security.approvals.decide(approval.id, true);
    await rejected;
    await assert.rejects(readFile(join(second, "config.txt")));
    await assert.rejects(readFile(join(parked, "config.txt")));
  } finally {
    security.approvals.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("host Bash requires approval before executing exact command", { skip: process.platform !== "darwin" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-tool-security-"));
  const target = join(root, "host.txt");
  const security = new ToolSecurity({ cwd: root, dataRoot: root });
  try {
    const run = await security.prepare("session-a", () => {});
    const bash = security.tools.find(tool => tool.name === "bash")!;
    const command = `printf host > '${target}'`;
    const pending = run.execute(() => bash.execute("call-host", { command, host: true }, new AbortController().signal));
    const approval = await pendingApproval(security);
    assert.equal(approval.target, command);
    await assert.rejects(readFile(target));
    security.approvals.decide(approval.id, true);
    const result = await pending;
    assert.equal(await readFile(target, "utf8"), "host");
    assert.match(JSON.stringify(result.content), /User approved this one-time host command.*executed/);
  } finally {
    security.approvals.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("cancelling a pending host Bash approval prevents command execution", { skip: process.platform !== "darwin" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-host-cancel-pending-"));
  const target = join(root, "not-run.txt");
  const events: Array<{ type: string }> = [];
  const security = new ToolSecurity({ cwd: root, dataRoot: root });
  try {
    const run = await security.prepare("session-a", event => { events.push(event); });
    const bash = security.tools.find(tool => tool.name === "bash")!;
    const controller = new AbortController();
    const pending = run.execute(() => bash.execute("call-host", {
      command: `printf started > '${target}'`, host: true,
    }, controller.signal));
    await pendingApproval(security);
    controller.abort();
    await assert.rejects(pending, /did not approve|aborted/i);
    await assert.rejects(readFile(target));
    assert.deepEqual(security.approvals.pending(), []);
    assert.equal(events.filter(event => event.type === "security-tool-committed").length, 0);
  } finally {
    security.approvals.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("aborting an executing host command records uncertain effects after a visible side effect", { skip: process.platform !== "darwin" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-host-cancel-running-"));
  const target = join(root, "started.txt");
  const events: Array<{ type: string }> = [];
  const security = new ToolSecurity({ cwd: root, dataRoot: root });
  try {
    const run = await security.prepare("session-a", event => { events.push(event); });
    const bash = security.tools.find(tool => tool.name === "bash")!;
    const controller = new AbortController();
    const pending = run.execute(() => bash.execute("call-host", {
      command: `printf started > '${target}'; sleep 5`, host: true,
    }, controller.signal));
    const rejection = assert.rejects(pending, /may have run.*check side effects before retrying/i);
    const approval = await pendingApproval(security);
    security.approvals.decide(approval.id, true);
    let content: string | undefined;
    for (let attempt = 0; attempt < 100 && content === undefined; attempt += 1) {
      content = await readFile(target, "utf8").catch(() => undefined);
      if (content === undefined) await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(content, "started");
    controller.abort();
    await rejection;
    assert.equal(events.filter(event => event.type === "security-host-execution-uncertain").length, 1);
    assert.equal(events.filter(event => event.type === "security-tool-committed").length, 0);
  } finally {
    security.approvals.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("an approved host command may finish before a background task it starts", { skip: process.platform !== "darwin" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-host-background-"));
  const release = join(root, "release");
  const target = join(root, "background.txt");
  const security = new ToolSecurity({ cwd: root, dataRoot: root });
  try {
    const run = await security.prepare("session-a", () => {});
    const bash = security.tools.find(tool => tool.name === "bash")!;
    const command = `(for i in {1..50}; do if [ -e '${release}' ]; then printf background > '${target}'; exit 0; fi; sleep 0.05; done) >/dev/null 2>&1 </dev/null &`;
    const pending = run.execute(() => bash.execute("call-background", { command, host: true, timeout: 2 }, new AbortController().signal));
    const approval = await pendingApproval(security);
    assert.equal(approval.target, command);
    await assert.rejects(readFile(target));
    security.approvals.decide(approval.id, true);
    await pending;
    await assert.rejects(readFile(target));
    await writeFile(release, "go");
    let content: string | undefined;
    for (let attempt = 0; attempt < 50 && content === undefined; attempt += 1) {
      content = await readFile(target, "utf8").catch(() => undefined);
      if (content === undefined) await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(content, "background");
  } finally {
    security.approvals.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("one approved host command does not authorize the next host command", { skip: process.platform !== "darwin" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-host-once-"));
  const first = join(root, "first.txt");
  const second = join(root, "second.txt");
  const security = new ToolSecurity({ cwd: root, dataRoot: root });
  try {
    const run = await security.prepare("session-a", () => {});
    const bash = security.tools.find(tool => tool.name === "bash")!;
    const firstCommand = `printf first > '${first}'`;
    const firstPending = run.execute(() => bash.execute("call-first", { command: firstCommand, host: true }, new AbortController().signal));
    const firstApproval = await pendingApproval(security);
    security.approvals.decide(firstApproval.id, true);
    await firstPending;
    assert.equal(await readFile(first, "utf8"), "first");

    const secondCommand = `printf second > '${second}'`;
    const secondPending = run.execute(() => bash.execute("call-second", { command: secondCommand, host: true }, new AbortController().signal));
    const secondRejection = assert.rejects(secondPending, /User did not approve/);
    const secondApproval = await pendingApproval(security);
    assert.notEqual(secondApproval.id, firstApproval.id);
    assert.equal(secondApproval.target, secondCommand);
    await assert.rejects(readFile(second));
    security.approvals.decide(secondApproval.id, false);
    await secondRejection;
    await assert.rejects(readFile(second));
  } finally {
    security.approvals.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("approved host Bash nonzero exit reports approval and failure without claiming success", { skip: process.platform !== "darwin" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-tool-security-"));
  const security = new ToolSecurity({ cwd: root, dataRoot: root });
  try {
    const run = await security.prepare("session-a", () => {});
    const bash = security.tools.find(tool => tool.name === "bash")!;
    const pending = run.execute(() => bash.execute("call-host-fail", { command: "exit 7", host: true }, new AbortController().signal));
    const rejected = assert.rejects(pending, /User approved this one-time host command.*executed.*(?:exited with code 7|failed)/s);
    const approval = await pendingApproval(security);
    security.approvals.decide(approval.id, true);
    await rejected;
  } finally {
    security.approvals.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a committed file change stays reported as committed when its audit event fails", { skip: process.platform !== "darwin" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-tool-security-"));
  const target = join(root, "config.txt");
  const security = new ToolSecurity({ cwd: root, dataRoot: root });
  try {
    const run = await security.prepare("session-a", event => {
      if (event.type === "security-tool-committed") throw new Error("audit disk full");
    });
    const write = security.tools.find(tool => tool.name === "write")!;
    const pending = run.execute(() => write.execute("call-audit-fail", { path: target, content: "saved" }, new AbortController().signal));
    const approval = await pendingApproval(security);
    security.approvals.decide(approval.id, true);
    const result = await pending;
    assert.equal(await readFile(target, "utf8"), "saved");
    assert.match(JSON.stringify(result.content), /change committed.*audit.*failed/i);
  } finally {
    security.approvals.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("an executed host command stays reported as executed when its audit event fails", { skip: process.platform !== "darwin" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-tool-security-"));
  const target = join(root, "host.txt");
  const security = new ToolSecurity({ cwd: root, dataRoot: root });
  try {
    const run = await security.prepare("session-a", event => {
      if (event.type === "security-tool-committed") throw new Error("audit disk full");
    });
    const bash = security.tools.find(tool => tool.name === "bash")!;
    const command = `printf host > '${target}'`;
    const pending = run.execute(() => bash.execute("call-host-audit-fail", { command, host: true }, new AbortController().signal));
    const approval = await pendingApproval(security);
    security.approvals.decide(approval.id, true);
    const result = await pending;
    assert.equal(await readFile(target, "utf8"), "host");
    assert.match(JSON.stringify(result.content), /command executed.*audit.*failed/i);
  } finally {
    security.approvals.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("timed-out host Bash records uncertain execution after a visible side effect", { skip: process.platform !== "darwin" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-tool-security-"));
  const target = join(root, "host-timeout.txt");
  const events: unknown[] = [];
  const security = new ToolSecurity({ cwd: root, dataRoot: root });
  try {
    const run = await security.prepare("session-a", event => { events.push(event); });
    const bash = security.tools.find(tool => tool.name === "bash")!;
    const command = `printf started > '${target}'; sleep 2`;
    const pending = run.execute(() => bash.execute("call-host-timeout", { command, host: true, timeout: 0.2 }, new AbortController().signal));
    const rejection = assert.rejects(pending, /may have run.*check.*before retrying/i);
    const approval = await pendingApproval(security);
    security.approvals.decide(approval.id, true);
    await rejection;
    assert.equal(await readFile(target, "utf8"), "started");
    assert.equal(events.filter(event => (event as { type: string }).type === "security-host-execution-uncertain").length, 1);
    assert.equal(events.filter(event => (event as { type: string }).type === "security-tool-committed").length, 0);
  } finally {
    security.approvals.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("large Bash output is captured only inside the task output sandbox", { skip: process.platform !== "darwin" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-tool-security-"));
  const security = new ToolSecurity({ cwd: root, dataRoot: root });
  try {
    const run = await security.prepare("session-a", () => {});
    const bash = security.tools.find(tool => tool.name === "bash")!;
    const result = await run.execute(() => bash.execute(
      "call-large-output",
      { command: "head -c 60000 /dev/zero | tr '\\000' x" },
      new AbortController().signal,
    ));
    const logPath = (result.details as { fullOutputPath?: string }).fullOutputPath;
    assert.ok(logPath);
    assert.ok(logPath.startsWith(run.outputRoot + sep), "log escaped task output");
    assert.equal((await readFile(logPath, "utf8")).length, 60000);
  } finally {
    security.approvals.close();
    await rm(root, { recursive: true, force: true });
  }
});
