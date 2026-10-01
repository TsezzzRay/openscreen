import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { DEFAULT_COMPACTION_SETTINGS, prepareCompaction } from "@earendil-works/pi-agent-core";
import { COMPACTION_PROVENANCE_INSTRUCTIONS, PiAgentService } from "../../../src/agent/pi/service.js";
import type { PiSessionRuntime } from "../../../src/agent/pi/session-runtime.js";
import { ApplicationRuntime } from "../../../src/application/runtime.js";
import { TurnTrace } from "../../../src/application/diagnostics/turn-trace.js";
import type { TracePayload } from "../../../src/application/diagnostics/schema.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "openscreen-compact-cancel-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const faux = fauxProvider({ provider: "compact-cancel", models: [{ id: "test", input: ["text"] }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const service = new PiAgentService({ cwd: root, sessionsRoot: join(root, "sessions"), models, model: faux.getModel() });
  const sessionId = (await service.createSession()).session.id;
  const runtime = (service as unknown as { runtime: PiSessionRuntime }).runtime;
  const entry = await runtime.getEntry(sessionId);
  await entry.session.appendMessage({ role: "user", content: "Keep the unfinished task", timestamp: Date.now() });
  await entry.session.appendMessage(fauxAssistantMessage("old evidence ".repeat(10_000)));
  await entry.session.appendMessage({ role: "user", content: "Continue checking", timestamp: Date.now() });
  for (let index = 0; index < 12; index++) {
    const id = `call-${index}`;
    await entry.session.appendMessage(fauxAssistantMessage([fauxToolCall("read", {}, { id })], { stopReason: "toolUse" }));
    await entry.session.appendMessage({ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text: `evidence ${index} `.repeat(1500) }], isError: false, timestamp: Date.now() });
  }
  await entry.session.appendMessage(fauxAssistantMessage("Still unfinished"));
  const preparation = prepareCompaction(await entry.session.getBranch(), DEFAULT_COMPACTION_SETTINGS);
  assert.ok(preparation.ok && preparation.value?.isSplitTurn);
  assert.ok(preparation.value.messagesToSummarize.length > 0);
  return { service, sessionId, entry, models, faux };
}

for (const cancelAt of [1, 2]) {
  test(`cancelling real Pi compaction at request ${cancelAt} prevents late publication and further requests`, async t => {
    const { service, sessionId, entry, models, faux } = await fixture(t);
    const entered = deferred();
    const release = deferred();
    t.after(release.resolve);
    let requests = 0;
    let requestSignal: AbortSignal | undefined;
    models.completeSimple = async (_model, _context, options) => {
      if (++requests === cancelAt) {
        requestSignal = options?.signal;
        entered.resolve();
        // Deliberately uncooperative transport: a late result must not mutate the Session.
        await release.promise;
      }
      return fauxAssistantMessage("Controlled summary");
    };
    const pending = service.compact(sessionId);
    const rejected = assert.rejects(pending, { code: "aborted" });
    await entered.promise;
    await service.abort(sessionId);
    assert.equal(requestSignal?.aborted, true);
    await rejected;
    assert.equal((await entry.session.getEntries()).filter(value => value.type === "compaction").length, 0);
    // The next turn must work even before the old transport settles.
    faux.setResponses([fauxAssistantMessage("next turn")]);
    assert.equal((await service.prompt(sessionId, { text: "next" })).answer, "next turn");
    release.resolve();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(requests, cancelAt);
    assert.equal((await entry.session.getEntries()).filter(value => value.type === "compaction").length, 0);
  });
}

test("cancellation after the final compaction model response prevents a checkpoint", async t => {
  const { service, sessionId, entry, models } = await fixture(t);
  let requests = 0;
  models.completeSimple = async () => { requests++; return fauxAssistantMessage("summary"); };
  await assert.rejects(service.compact(sessionId, undefined, undefined, async event => {
    if (event.type === "model-end" && requests === 2) await service.abort(sessionId);
  }), { code: "aborted" });
  assert.equal(requests, 2);
  assert.equal((await entry.session.getEntries()).filter(value => value.type === "compaction").length, 0);
});

test("cancellation from a Pi compaction hook prevents model requests and persistence", async t => {
  const { service, sessionId, entry, models } = await fixture(t);
  let requests = 0;
  models.completeSimple = async () => { requests++; return fauxAssistantMessage("summary"); };
  entry.harness.on("session_before_compact", async () => { await service.abort(sessionId); return undefined; });
  await assert.rejects(service.compact(sessionId), { code: "aborted" });
  assert.equal(requests, 0);
  assert.equal((await entry.session.getEntries()).filter(value => value.type === "compaction").length, 0);
});

test("ordinary compaction model failures retain provider classification", async t => {
  const { service, sessionId, models } = await fixture(t);
  models.completeSimple = async () => fauxAssistantMessage("", { stopReason: "error", errorMessage: "transport failed" });
  await assert.rejects(service.compact(sessionId), { code: "provider" });
});

test("cancellation during entry ID allocation prevents dispatch to storage", async t => {
  const { service, sessionId, entry, models } = await fixture(t);
  models.completeSimple = async () => fauxAssistantMessage("summary");
  const storage = entry.session.getStorage();
  const createId = storage.createEntryId.bind(storage);
  const allocating = deferred();
  const release = deferred();
  storage.createEntryId = async () => { allocating.resolve(); await release.promise; return createId(); };
  const pending = service.compact(sessionId);
  const rejected = assert.rejects(pending, { code: "aborted" });
  await allocating.promise;
  await service.abort(sessionId);
  release.resolve();
  await rejected;
  assert.equal((await entry.session.getEntries()).filter(value => value.type === "compaction").length, 0);
});

test("cancellation cannot retract a checkpoint already dispatched to Pi storage", async t => {
  const { service, sessionId, entry, models } = await fixture(t);
  models.completeSimple = async () => fauxAssistantMessage("summary");
  const runtime = (service as unknown as { runtime: PiSessionRuntime }).runtime;
  const appendFile = runtime.env.appendFile.bind(runtime.env);
  const dispatched = deferred();
  const release = deferred();
  t.after(release.resolve);
  runtime.env.appendFile = async (path, content) => {
    if (JSON.parse(typeof content === "string" ? content : Buffer.from(content).toString("utf8")).type === "compaction") {
      dispatched.resolve();
      await release.promise;
    }
    return appendFile(path, content);
  };
  const pending = assert.rejects(service.compact(sessionId), { code: "aborted" });
  await dispatched.promise;
  await service.abort(sessionId);
  release.resolve();
  await pending;
  // The SDK accepts no signal at this boundary: the owning request fails,
  // but a previously dispatched filesystem append is not reversible.
  assert.equal((await entry.session.getEntries()).filter(value => value.type === "compaction").length, 1);
});

test("cancelling one Session does not affect another Session's compaction", async t => {
  const { service, sessionId, entry, models } = await fixture(t);
  const otherId = (await service.createSession()).session.id;
  const runtime = (service as unknown as { runtime: PiSessionRuntime }).runtime;
  const other = await runtime.getEntry(otherId);
  for (const value of await entry.session.getBranch()) if (value.type === "message") await other.session.appendMessage(value.message);
  const entered = deferred();
  const release = deferred();
  let requests = 0;
  models.completeSimple = async () => {
    if (++requests === 1) { entered.resolve(); await release.promise; }
    return fauxAssistantMessage("summary");
  };
  const pending = service.compact(sessionId);
  const rejected = assert.rejects(pending, { code: "aborted" });
  await entered.promise;
  const otherPending = service.compact(otherId);
  await service.abort(sessionId);
  await rejected;
  await otherPending;
  release.resolve();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal((await entry.session.getEntries()).filter(value => value.type === "compaction").length, 0);
  assert.equal((await other.session.getEntries()).filter(value => value.type === "compaction").length, 1);
});

test("successful compaction still uses Pi split summaries and writes one checkpoint", async t => {
  const { service, sessionId, entry, models } = await fixture(t);
  let requests = 0;
  models.completeSimple = async () => fauxAssistantMessage(`summary ${++requests}`);
  const result = await service.compact(sessionId);
  assert.equal(requests, 2);
  assert.match(result.summary, /summary 1[\s\S]*summary 2/);
  assert.equal((await entry.session.getEntries()).filter(value => value.type === "compaction").length, 1);
});

for (const automatic of [false, true]) {
  test(`${automatic ? "automatic" : "manual"} compaction applies provenance to history and turn-prefix model requests without leaking to the next prompt`, async t => {
    const { service, sessionId, entry, models, faux } = await fixture(t);
    const prompts: string[] = [];
    const complete = async (_model: unknown, context: { systemPrompt?: string }) => {
      prompts.push(context.systemPrompt ?? "");
      return fauxAssistantMessage("Controlled summary");
    };
    models.completeSimple = complete;
    if (automatic) {
      const response = fauxAssistantMessage("unfinished");
      response.usage.input = faux.getModel().contextWindow;
      response.usage.totalTokens = response.usage.input;
      await entry.session.appendMessage(response);
      await service.compactIfNeeded(sessionId);
    } else {
      await service.compact(sessionId);
    }
    assert.equal(prompts.length, 2);
    for (const prompt of prompts) {
      assert.ok(prompt.includes(COMPACTION_PROVENANCE_INSTRUCTIONS), "every compaction request needs system-level provenance");
      assert.match(prompt, /local fragment[\s\S]*whole conversation/i);
      assert.match(prompt, /not visible in this fragment/i);
      assert.match(prompt, /preserve.*stated role/i);
      assert.match(prompt, /do not add.*restrictions/i);
    }
    assert.equal(models.completeSimple, complete, "shared Models must not be mutated");
    faux.setResponses([(context) => {
      assert.ok(!context.systemPrompt?.includes(COMPACTION_PROVENANCE_INSTRUCTIONS));
      return fauxAssistantMessage("next turn");
    }]);
    assert.equal((await service.prompt(sessionId, { text: "next" })).answer, "next turn");
    assert.equal(prompts.length, 2);
  });
}

test("manual compaction traces both real model requests under its owning Turn", async t => {
  const { service, sessionId, models } = await fixture(t);
  let requests = 0;
  models.completeSimple = async () => fauxAssistantMessage(`PRIVATE summary ${++requests}`);
  const records: TracePayload[] = [];
  const runtime = new ApplicationRuntime({ agent: service,
    capture: { async start() {}, async stop() {}, async capture() { return { type: "frames", frames: [], images: [] }; } },
    turnDiagnostics: ids => new TurnTrace({ threadId: ids.sessionId, turnId: ids.requestId, requestId: ids.requestId }, (_id, value) => { records.push(value); }),
  });
  await runtime.execute({ type: "compact", requestId: "compact", sessionId }, () => {});
  const starts = records.filter(value => value.type === "inference_started");
  const ends = records.filter(value => value.type === "inference_completed");
  assert.equal(starts.length, 2);
  assert.equal(ends.length, 2);
  assert.ok(starts.every(value => value.codex_turn_id === "compact"));
  assert.deepEqual(ends.map(value => value.inference_call_id), starts.map(value => value.inference_call_id));
  assert.notEqual(starts[0].inference_call_id, starts[1].inference_call_id);
  assert.doesNotMatch(JSON.stringify(records), /PRIVATE/);
});

for (const kind of ["prompt", "compact"] as const) {
  test(`Application cancellation owns ${kind === "prompt" ? "automatic" : "manual"} real Pi compaction`, async t => {
    const { service, sessionId, entry, models, faux } = await fixture(t);
    const entered = deferred();
    const release = deferred();
    let signal: AbortSignal | undefined;
    models.completeSimple = async (_model, _context, options) => {
      signal = options?.signal;
      entered.resolve();
      await release.promise;
      return fauxAssistantMessage("late summary");
    };
    const response = fauxAssistantMessage("answer");
    response.usage.input = faux.getModel().contextWindow;
    response.usage.totalTokens = response.usage.input;
    faux.setResponses([response]);
    const records: TracePayload[] = [];
    const events: string[] = [];
    const runtime = new ApplicationRuntime({ agent: service,
      capture: { async start() {}, async stop() {}, async capture() { return { type: "frames", frames: [], images: [] }; } },
      turnDiagnostics: ids => new TurnTrace({ threadId: ids.sessionId, turnId: ids.requestId, requestId: ids.requestId }, (_id, value) => { records.push(value); }),
    });
    t.after(async () => { release.resolve(); await runtime.stop(); });
    const command = kind === "prompt"
      ? { type: kind, requestId: "owner", sessionId, input: { text: "Continue" } }
      : { type: kind, requestId: "owner", sessionId };
    const pending = runtime.execute(command, event => { events.push(event.type); });
    await entered.promise;
    await runtime.execute({ type: "abort", requestId: "cancel", sessionId, targetRequestId: "owner" }, () => {});
    await pending;
    assert.equal(signal?.aborted, true);
    assert.deepEqual(events, kind === "prompt" ? ["run_started", "answer_delta", "answer_completed", "failed"] : ["failed"]);
    assert.deepEqual(records.at(-1), { type: "codex_turn_ended", codex_turn_id: "owner", status: "cancelled" });
    const compactionStart = records.findIndex(value => value.type === "other" && value.metadata.phase === "compaction" && value.metadata.boundary === "start");
    const compactionRecords = records.slice(compactionStart);
    assert.equal(compactionRecords.filter(value => value.type === "inference_started").length, 1);
    assert.equal(compactionRecords.filter(value => value.type === "inference_completed").length, 0);
    release.resolve();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(records.filter(value => value.type === "inference_completed").length, kind === "prompt" ? 1 : 0);
    assert.equal((await entry.session.getEntries()).filter(value => value.type === "compaction").length, 0);
  });
}

test("a cancelled queued compaction never calls the provider", async t => {
  const { service, sessionId, models } = await fixture(t);
  const runtime = (service as unknown as { runtime: PiSessionRuntime }).runtime;
  const entered = deferred();
  const release = deferred();
  const mutation = runtime.mutate(sessionId, async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  let requests = 0;
  models.completeSimple = async () => { requests++; return fauxAssistantMessage("summary"); };
  const pending = service.compact(sessionId);
  const rejected = assert.rejects(pending, { code: "aborted" });
  await service.abort(sessionId);
  release.resolve();
  await mutation;
  await rejected;
  assert.equal(requests, 0);
});

test("queued compaction cancellation settles without releasing its predecessor or bypassing it", async t => {
  const { service, sessionId, models } = await fixture(t);
  const runtime = (service as unknown as { runtime: PiSessionRuntime }).runtime;
  const entered = deferred();
  const release = deferred();
  t.after(release.resolve);
  const current = runtime.mutate(sessionId, async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  let requests = 0;
  models.completeSimple = async () => { requests++; return fauxAssistantMessage("summary"); };
  const controller = new AbortController();
  let settled = false;
  const queued = assert.rejects(service.compact(sessionId, undefined, controller.signal), { code: "aborted" })
    .then(() => { settled = true; });
  controller.abort();
  await new Promise<void>(resolve => setImmediate(resolve));
  let followingStarted = false;
  const following = runtime.mutate(sessionId, async () => { followingStarted = true; });
  await new Promise<void>(resolve => setImmediate(resolve));
  const beforeRelease = { settled, followingStarted, requests };
  release.resolve();
  await Promise.all([current, queued, following]);
  assert.deepEqual(beforeRelease, { settled: true, followingStarted: false, requests: 0 });
});

test("cancelling a queued prompt leaves the preceding manual compaction running", async t => {
  const { service, sessionId, models } = await fixture(t);
  const entered = deferred();
  const release = deferred();
  let signal: AbortSignal | undefined;
  models.completeSimple = async (_model, _context, options) => {
    signal = options?.signal;
    entered.resolve();
    await release.promise;
    return fauxAssistantMessage("summary");
  };
  const captureFinished = deferred();
  const records: TracePayload[] = [];
  const runtime = new ApplicationRuntime({ agent: service,
    capture: { async start() {}, async stop() {}, async capture() { captureFinished.resolve(); return { type: "frames", frames: [], images: [] }; } },
    turnDiagnostics: ids => new TurnTrace({ threadId: ids.sessionId, turnId: ids.requestId, requestId: ids.requestId }, (_id, value) => { records.push(value); }),
  });
  t.after(async () => { release.resolve(); await runtime.stop(); });
  const currentEvents: string[] = [];
  const current = runtime.execute({ type: "compact", requestId: "current", sessionId }, event => { currentEvents.push(event.type); });
  await entered.promise;
  let queuedSettled = false;
  const queuedEvents: string[] = [];
  const queued = runtime.execute({ type: "prompt", requestId: "queued", sessionId, input: { text: "next" } }, event => { queuedEvents.push(event.type); })
    .then(() => { queuedSettled = true; });
  await captureFinished.promise;
  await new Promise<void>(resolve => setImmediate(resolve));
  await runtime.execute({ type: "abort", requestId: "cancel", sessionId, targetRequestId: "queued" }, () => {});
  await new Promise<void>(resolve => setImmediate(resolve));
  const beforeRelease = { aborted: signal?.aborted, queuedSettled };
  release.resolve();
  await Promise.all([current, queued]);
  assert.deepEqual(beforeRelease, { aborted: false, queuedSettled: true });
  assert.deepEqual(currentEvents, ["compaction_completed", "completed"]);
  assert.deepEqual(queuedEvents, ["failed"]);
  assert.ok(records.some(value => value.type === "codex_turn_ended" && value.codex_turn_id === "queued" && value.status === "cancelled"));
});

test("consecutive Pi compactions preserve cumulative file operations after reopening the Session", async t => {
  const { service, sessionId, entry, models, faux } = await fixture(t);
  models.completeSimple = async () => fauxAssistantMessage("summary");
  await entry.session.appendMessage({ role: "user", content: "Inspect old.ts and update changed.ts", timestamp: Date.now() });
  await entry.session.appendMessage(fauxAssistantMessage([
    fauxToolCall("read", { path: "old.ts" }, { id: "read-old" }),
    fauxToolCall("edit", { path: "changed.ts", oldText: "old", newText: "new" }, { id: "edit-old" }),
  ], { stopReason: "toolUse" }));
  await entry.session.appendMessage({ role: "toolResult", toolCallId: "read-old", toolName: "read", content: [{ type: "text", text: "old" }], isError: false, timestamp: Date.now() });
  await entry.session.appendMessage({ role: "toolResult", toolCallId: "edit-old", toolName: "edit", content: [{ type: "text", text: "edited" }], isError: false, timestamp: Date.now() });
  await entry.session.appendMessage({ role: "user", content: "Continue independently", timestamp: Date.now() });
  await entry.session.appendMessage(fauxAssistantMessage("new evidence ".repeat(20_000)));
  await service.compact(sessionId);
  const first = (await entry.session.getBranch()).filter(value => value.type === "compaction").at(-1)!;
  assert.equal(first.fromHook, false);
  assert.deepEqual(first.details, { readFiles: ["old.ts"], modifiedFiles: ["changed.ts"] });
  await entry.session.appendMessage({ role: "user", content: "Continue again", timestamp: Date.now() });
  await entry.session.appendMessage(fauxAssistantMessage("more evidence ".repeat(20_000)));
  const reopened = new PiAgentService({ cwd: entry.harness.env.cwd, sessionsRoot: join(entry.harness.env.cwd, "sessions"), models, model: faux.getModel() });
  await reopened.compact(sessionId);
  const reopenedRuntime = (reopened as unknown as { runtime: PiSessionRuntime }).runtime;
  const reopenedEntry = await reopenedRuntime.getEntry(sessionId);
  const second = (await reopenedEntry.session.getBranch()).filter(value => value.type === "compaction").at(-1)!;
  assert.notEqual(second.id, first.id);
  assert.deepEqual(second.details, first.details);
});

test("cancelling a queued manual request does not cancel the current request in the same Session", async t => {
  const { service, sessionId, models } = await fixture(t);
  const entered = deferred();
  const release = deferred();
  let signal: AbortSignal | undefined;
  let requests = 0;
  models.completeSimple = async (_model, _context, options) => {
    if (++requests === 1) { signal = options?.signal; entered.resolve(); await release.promise; }
    return fauxAssistantMessage("summary");
  };
  const runtime = new ApplicationRuntime({ agent: service,
    capture: { async start() {}, async stop() {}, async capture() { return { type: "frames", frames: [], images: [] }; } },
  });
  const currentEvents: string[] = [];
  const queuedEvents: string[] = [];
  const current = runtime.execute({ type: "compact", requestId: "current", sessionId }, event => { currentEvents.push(event.type); });
  await entered.promise;
  const queued = runtime.execute({ type: "compact", requestId: "queued", sessionId }, event => { queuedEvents.push(event.type); });
  await runtime.execute({ type: "abort", requestId: "cancel", sessionId, targetRequestId: "queued" }, () => {});
  const aborted = signal?.aborted;
  release.resolve();
  await Promise.all([current, queued]);
  assert.equal(aborted, false);
  assert.deepEqual(currentEvents, ["compaction_completed", "completed"]);
  assert.deepEqual(queuedEvents, ["failed"]);
  assert.equal(requests, 2);
});
