import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createRun, appendEvent, finishTrial, readRun, hash } from '../../dist-evals/evals/persistence.js';

test('persists incomplete trials and refuses to overwrite completed evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'openscreen-eval-test-'));
  try {
    const run = await createRun(root, { runId: 'example', tasks: [{ id: 'task', workload: 'agent' }], trials: 2 });
    await appendEvent(run, 'task-1', { type: 'answer', text: 'evidence' });
    await finishTrial(run, 'task-1', { status: 'completed', output: 'answer' });
    const result = await readRun(run);
    assert.equal(result.trials[0].status, 'completed');
    assert.equal(result.trials[1].status, 'incomplete');
    await assert.rejects(finishTrial(run, 'task-1', { status: 'completed' }));
    await assert.rejects(createRun(root, { runId: 'example', tasks: [], trials: 1 }));
    assert.match(await readFile(join(run, 'traces/task-1.jsonl'), 'utf8'), /evidence/);
    await assert.rejects(appendEvent(run, '../escape', {}), /identifier/);
    assert.equal(hash({ a: 1 }), hash({ a: 1 }));
  } finally { await rm(root, { recursive: true, force: true }); }
});
