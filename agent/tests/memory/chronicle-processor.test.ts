import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import OpenAI from "openai";

import { processNextChronicle } from "../../src/harness/memory/chronicle/processor.js";
import { ChronicleRepository } from "../../src/harness/memory/chronicle/repository.js";
import { openMemoryDatabase } from "../../src/harness/memory/db/database.js";
import type { ScreenObservation } from "../../src/extensions/screen-observation/types.js";
import { testMemoryConfig } from "./test-config.js";

function observation(index: number): ScreenObservation {
  const occurredAt = new Date(Date.parse("2026-08-04T10:00:01.000Z") + index).toISOString();
  return {
    schemaVersion: 1,
    id: String(index),
    occurredAt,
    capturedAt: occurredAt,
    trigger: { type: "focusedWindowChanged" },
    window: { processIdentifier: 42, applicationName: "Safari" },
    screenshot: { status: "complete", durationMilliseconds: 1 },
    accessibility: { status: "complete", durationMilliseconds: 1 },
    visibleText: `Observation ${index}`,
    diagnostics: {
      triggerToCaptureMilliseconds: 1,
      screenshotDurationMilliseconds: 1,
      accessibilityDurationMilliseconds: 1,
    },
  };
}

test("summarizes a Chronicle window in requests of at most ten observations", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-chronicle-processor-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const database = openMemoryDatabase(root);
  t.after(() => database.close());
  const repository = new ChronicleRepository(database, testMemoryConfig({
    chronicle: { maxSourcesPerRequest: 10 },
  }));
  for (let index = 10; index >= 0; index -= 1) {
    repository.ingestObservation(observation(index));
  }
  const requestSizes: number[] = [];
  const client = {
    responses: {
      inputTokens: { count: async () => ({ input_tokens: 100 }) },
      create: async (request: { input: Array<{ content: string }> }) => {
        const input = JSON.parse(request.input[0]?.content ?? "{}");
        requestSizes.push(input.observations.length);
        return {
          status: "completed",
          output_text: JSON.stringify({
            activities: [{
              summary: "The user viewed OpenScreen material.",
              source_ids: input.observations.map(
                ({ sourceId }: { sourceId: string }) => sourceId,
              ),
              application: "Safari",
              window_title: null,
            }],
            source_summary: "The user viewed OpenScreen material.",
          }),
          usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
        };
      },
    },
  } as unknown as OpenAI;

  const result = await processNextChronicle({
    repository,
    client,
    model: "summary-model",
    workerId: "chronicle-worker",
    contextWindowTokens: 10_000,
    now: () => Date.parse("2026-08-04T10:01:15.000Z"),
  });

  assert.deepEqual(result, {
    status: "processed",
    jobKey: "chronicle:chronicle-window:2026-08-04T10:00:00.000Z",
    requestCount: 2,
  });
  assert.deepEqual(requestSizes, [10, 1]);
});
