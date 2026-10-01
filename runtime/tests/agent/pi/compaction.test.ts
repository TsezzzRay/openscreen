import assert from "node:assert/strict";
import test from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { AgentHarness, Session } from "@earendil-works/pi-agent-core";
import { PiAgentService } from "../../../src/agent/pi/service.js";
import { createRuntime, sessionRuntimeProbe } from "./test-fixture.js";

test("compactIfNeeded delegates only when pi compaction policy says so", async (t) => {
  const { options } = createRuntime(t);
  let usage = {
    input: options.model.contextWindow,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: options.model.contextWindow + 1,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const service = new PiAgentService(options);
  const created = await service.createSession();
  const serviceProbe = sessionRuntimeProbe<{
    entries: Map<string, Promise<{ harness: AgentHarness; session: Session }>>;
  }>(service);
  const entry = await serviceProbe.entries.get(created.session.id)!;
  const sessionProbe = entry.session as unknown as {
    getBranch(): Promise<unknown[]>;
    getEntries(): Promise<unknown[]>;
  };
  sessionProbe.getEntries = async () => {
    throw new Error("inactive branches must not drive compaction");
  };
  sessionProbe.getBranch = async () => [
    {
      type: "message",
      id: "assistant-entry",
      parentId: null,
      timestamp: "2026-08-13T00:00:00.000Z",
      message: {
        ...fauxAssistantMessage("large-context answer"),
        usage,
      },
    },
  ];
  let compactionCalls = 0;
  let compactionInstructions: string | undefined;
  const harnessProbe = entry.harness as unknown as {
    compact(instructions?: string): Promise<{
      summary: string;
      firstKeptEntryId: string;
      tokensBefore: number;
    }>;
  };
  harnessProbe.compact = async (instructions) => {
    compactionCalls += 1;
    compactionInstructions = instructions;
    return {
      summary: "automatic summary",
      firstKeptEntryId: "kept-entry",
      tokensBefore: usage.totalTokens,
    };
  };

  const compacted = await service.compactIfNeeded(created.session.id);

  assert.deepEqual(compacted, {
    summary: "automatic summary",
    firstKeptEntryId: "kept-entry",
    tokensBefore: usage.totalTokens,
  });
  assert.equal(compactionCalls, 1);
  assert.match(compactionInstructions ?? "", /task goals and constraints.*user messages/i);
  assert.match(compactionInstructions ?? "", /tool output.*source.*evidence/i);
  assert.match(compactionInstructions ?? "", /do not infer.*task target/i);
  assert.match(compactionInstructions ?? "", /not specified the task target.*input format.*tool output/i);

  usage = {
    ...usage,
    input: 1,
    output: 1,
    totalTokens: 2,
  };
  assert.equal(await service.compactIfNeeded(created.session.id), undefined);
  assert.equal(compactionCalls, 1);
});

test("manual compaction preserves user instructions alongside provenance rules", async (t) => {
  const { options } = createRuntime(t);
  const service = new PiAgentService(options);
  const created = await service.createSession();
  const probe = sessionRuntimeProbe<{
    entries: Map<string, Promise<{ harness: AgentHarness }>>;
  }>(service);
  const entry = await probe.entries.get(created.session.id)!;
  let receivedInstructions: string | undefined;
  (entry.harness as unknown as {
    compact(instructions?: string): Promise<{ summary: string; firstKeptEntryId: string; tokensBefore: number }>;
  }).compact = async (instructions) => {
    receivedInstructions = instructions;
    return { summary: "summary", firstKeptEntryId: "kept", tokensBefore: 10 };
  };

  await service.compact(created.session.id, "Focus on the pending API migration.");

  assert.match(receivedInstructions ?? "", /task goals and constraints.*user messages/i);
  assert.match(receivedInstructions ?? "", /not specified the task target.*input format.*tool output/i);
  assert.match(receivedInstructions ?? "", /Focus on the pending API migration\./);
});
