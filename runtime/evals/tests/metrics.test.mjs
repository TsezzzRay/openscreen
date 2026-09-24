import assert from 'node:assert/strict';
import { test } from 'node:test';
import { metrics } from '../../dist-evals/evals/metrics.js';

test('unknown Mastra cost stays unknown and cached input is counted', () => {
  const result = metrics([
    { event: { type: 'model-start' } },
    { event: { type: 'model-end', output: { usage: { input: 10, cacheRead: 5, output: 2, cost: { total: 0.1 } } } } },
    { event: { type: 'observation-start' } },
    { event: { type: 'observation-end', usage: { inputTokens: 20, outputTokens: 3 } } },
  ], 1000);
  assert.equal(result.knownInputTokens, 35);
  assert.equal(result.knownOutputTokens, 5);
  assert.equal(result.totalCostUsd, null);
  assert.equal(result.costRecords, 1);
  assert.equal(result.modelRequests, 2);
});

test('request latency excludes whole-trial overhead and distinguishes observation cycles', () => {
  const result = metrics([{event:{type:'model-start'}}, {event:{type:'model-end', durationMs:20}}, {event:{type:'observation-start'}}, {event:{type:'observation-end', durationMs:40}}], 1000);
  assert.deepEqual(result.requestDurationsMs, [20]);
  assert.deepEqual(result.memoryCycleDurationsMs, [40]);
  assert.equal(result.directModelRequests, 1);
  assert.equal(result.memoryCycles, 1);
  assert.equal(result.totalInputTokens, null);
});
