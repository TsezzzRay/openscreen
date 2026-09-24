import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as runner from '../../dist-evals/evals/runner.js';
import { readRun } from '../../dist-evals/evals/persistence.js';
import { loadApplicationConfig } from '../../dist-evals/src/runtime-config.js';
import { tasks } from '../../dist-evals/evals/dataset.js';

const { classifyFailure, runDataset } = runner;

test('baseline evaluates every scenario once', () => {
  assert.equal(runner.BASELINE_TRIALS, 1);
  assert.equal(runner.BASELINE_TIMEOUT_MS, 300_000);
});

test('provider cooldown is shared by waiters and honors later extensions', async () => {
  assert.equal(typeof runner.createProviderCooldown, 'function');
  let now = 0;
  const sleepers = [];
  const cooldown = runner.createProviderCooldown({
    now: () => now,
    sleep: milliseconds => new Promise(resolve => sleepers.push({ milliseconds, resolve })),
  });

  cooldown.extend(10000);
  const first = cooldown.wait();
  const second = cooldown.wait();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(sleepers.map(item => item.milliseconds), [10000, 10000]);

  now = 5000;
  cooldown.extend(20000);
  now = 10000;
  sleepers.splice(0, 2).forEach(item => item.resolve());
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(sleepers.map(item => item.milliseconds), [15000, 15000]);

  now = 25000;
  sleepers.splice(0, 2).forEach(item => item.resolve());
  await Promise.all([first, second]);
});

test('rate-limit retry uses two bounded cooldowns and ignores other provider failures', () => {
  assert.equal(typeof runner.rateLimitRetryDelay, 'function');
  assert.equal(runner.rateLimitRetryDelay('HTTP 429: rate_limit_error', 1), 10000);
  assert.equal(runner.rateLimitRetryDelay('Token Plan rate limit reached', 2), 20000);
  assert.equal(runner.rateLimitRetryDelay('HTTP 429: rate_limit_error', 3), null);
  assert.equal(runner.rateLimitRetryDelay('HTTP 503: overloaded', 1), null);
});

test('eval scheduler runs exactly two trials concurrently', async () => {
  assert.equal(typeof runner.runWithEvalConcurrency, 'function');
  let active = 0;
  let maximum = 0;
  const completed = [];
  await runner.runWithEvalConcurrency(Array.from({ length: 9 }, (_, index) => index), async item => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    completed.push(item);
    active -= 1;
  });
  assert.equal(maximum, 2);
  assert.deepEqual(completed.toSorted((left, right) => left - right), Array.from({ length: 9 }, (_, index) => index));
});

test('eval scheduler stops dispatching queued trials after cancellation', async () => {
  assert.equal(typeof runner.runWithEvalConcurrency, 'function');
  let interrupted = false;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const started = [];
  const running = runner.runWithEvalConcurrency(
    Array.from({ length: 9 }, (_, index) => index),
    async item => { started.push(item); await gate; },
    () => interrupted,
  );
  while (started.length < 2) await new Promise(resolve => setImmediate(resolve));
  interrupted = true;
  release();
  await running;
  assert.deepEqual(started.toSorted((left, right) => left - right), [0, 1]);
});

test('eval scheduler stops dispatching and drains active workers after an unexpected job error', async () => {
  const started = [];
  await assert.rejects(runner.runWithEvalConcurrency(
    Array.from({ length: 6 }, (_, index) => index),
    async item => {
      started.push(item);
      if (item === 0) throw new Error('fixture failure');
      await new Promise(resolve => setTimeout(resolve, 5));
    },
  ), /fixture failure/);
  assert.deepEqual(started.toSorted((left, right) => left - right), [0, 1]);
});

test('dataset runner records and uses the fixed concurrency', async () => {
  const root = await mkdtemp(join(tmpdir(), 'openscreen-eval-concurrency-'));
  try {
    const config = loadApplicationConfig();
    config.agent.provider = 'does-not-exist';
    const run = await runDataset(tasks.slice(0, 2), config, { root, trials: 1, timeoutMs: 10000 });
    const { manifest, trials } = await readRun(run);
    assert.equal(manifest.concurrency, 2);
    assert.match(manifest.executionBoundary, /sandboxed read-only Bash by default/i);
    assert.match(manifest.executionBoundary, /model-chosen sandboxed Bash/i);
    assert.deepEqual(trials.map(trial => trial.status), ['failed', 'failed']);

    const timings = await Promise.all(trials.map(async trial => {
      const events = (await readFile(join(run, 'traces', `${trial.trialId}.jsonl`), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      const started = events.find(entry => entry.event.type === 'attempt-start');
      const finished = events.find(entry => entry.event.type === 'attempt-finished');
      return { started: Date.parse(started.timestamp), finished: Date.parse(finished.timestamp) };
    }));
    assert.ok(Math.max(...timings.map(item => item.started)) < Math.min(...timings.map(item => item.finished)));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('runner persists worker errors and hard timeouts without contacting a provider', async () => {
  const root = await mkdtemp(join(tmpdir(), 'openscreen-eval-runner-'));
  try {
    const config = loadApplicationConfig();
    config.agent.provider = 'does-not-exist';
    const failed = await runDataset([tasks[0]], config, { root, trials: 1, timeoutMs: 10000 });
    const failedTrial = (await readRun(failed)).trials[0];
    assert.equal(failedTrial.status, 'failed');
    assert.equal(failedTrial.failureKind, 'configuration_error');
    assert.equal(failedTrial.attempts.length, 1);
    const timed = await runDataset([tasks[0]], config, { root, trials: 1, timeoutMs: 1 });
    const timedTrial = (await readRun(timed)).trials[0];
    assert.equal(timedTrial.status, 'timeout');
    assert.equal(timedTrial.failureKind, 'timeout');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('failure classifier separates provider, configuration and product failures', () => {
  assert.equal(classifyFailure('HTTP 529: provider overloaded'), 'provider_error');
  assert.equal(classifyFailure('HTTP 408: request timeout'), 'provider_error');
  assert.equal(classifyFailure('connect ETIMEDOUT 203.0.113.1:443'), 'provider_error');
  assert.equal(classifyFailure('getaddrinfo ENOTFOUND api.example.test'), 'provider_error');
  assert.equal(classifyFailure('Provider returned 503'), 'provider_error');
  assert.equal(classifyFailure('Configured eval model is not available'), 'configuration_error');
  assert.equal(classifyFailure('Chronicle output failed schema validation'), 'product_error');
  assert.equal(classifyFailure('Chronicle expected 512 items'), 'product_error');
});
